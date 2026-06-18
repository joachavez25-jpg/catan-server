'use strict';

const { generateBoard, HEX_DIRECTIONS, hexId, shuffleInPlace } = require('./board');
const {
  DEV_CARD_TYPES,
  STANDARD_DEV_CARD_DECK,
  BUILDING_COSTS,
  createPlayer,
  canAfford,
  deductResources,
  addResources,
  totalResourceCount,
} = require('./player');

const PHASES = {
  SETUP: 'setup',
  ROLL: 'roll',
  MAIN: 'main',
  MOVE_ROBBER: 'move_robber',
  DISCARD: 'discard',
  GAME_OVER: 'game_over',
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 4;
const VICTORY_POINTS_TO_WIN = 10;

function rollTwoDice(rng = Math.random) {
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  return { d1, d2, total: d1 + d2 };
}

class GameError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'GAME_ERROR';
  }
}

class CatanGame {
  constructor({ playerInfos, rng = Math.random, seed } = {}) {
    if (!playerInfos || playerInfos.length < MIN_PLAYERS || playerInfos.length > MAX_PLAYERS) {
      throw new GameError(`Catan requiere entre ${MIN_PLAYERS} y ${MAX_PLAYERS} jugadores`, 'INVALID_PLAYER_COUNT');
    }
    this.rng = rng;
    this.board = generateBoard(rng);
    this.players = playerInfos.map((info, i) => createPlayer(info.id, info.name, info.color));
    this.playerOrder = this.players.map((p) => p.id);
    this.currentPlayerIndex = 0;
    this.phase = PHASES.SETUP;
    this.turnNumber = 0;
    this.devCardDeck = shuffleInPlace([...STANDARD_DEV_CARD_DECK], rng);
    this.bank = { wood: 19, brick: 19, wheat: 19, sheep: 19, ore: 19 };
    this.robberHex = this.board.hexes.find((h) => h.resource === 'desert').id;
    this.log = [];
    this.lastDiceRoll = null;
    this.pendingDiscards = [];
    this.winner = null;

    this.setupQueue = [...this.playerOrder, ...[...this.playerOrder].reverse()];
    this.setupStep = 0;
    this.setupSubStep = 'settlement';
    this.setupLastSettlementVertex = null;

    this._addLog(`Partida creada con ${this.players.length} jugadores. Fase: colocación inicial.`);
  }

  _addLog(message) {
    this.log.push({ turn: this.turnNumber, message, ts: Date.now() });
  }

  get currentPlayer() {
    return this.players.find((p) => p.id === this.playerOrder[this.currentPlayerIndex]);
  }

  getPlayer(playerId) {
    const p = this.players.find((p) => p.id === playerId);
    if (!p) throw new GameError('Jugador no encontrado', 'PLAYER_NOT_FOUND');
    return p;
  }

  isSetupPhase() {
    return this.phase === PHASES.SETUP;
  }

  currentSetupPlayerId() {
    return this.setupQueue[this.setupStep];
  }

  placeSetupSettlement(playerId, vertexId) {
    this._assertCurrentSetupPlayer(playerId);
    this._assertPhase(PHASES.SETUP);
    if (this.setupSubStep !== 'settlement') {
      throw new GameError('Debes colocar el camino antes de continuar', 'WRONG_SETUP_STEP');
    }
    const vertex = this._getVertex(vertexId);
    this._assertVertexFreeAndLegal(vertexId, { ignoreDistanceFromOwnRoad: true });

    const player = this.getPlayer(playerId);
    vertex.building = { playerId, type: 'settlement' };
    player.buildings.settlements.push(vertexId);
    player.piecesLeft.settlement -= 1;

    const isSecondSettlement = this.setupStep >= this.players.length;
    if (isSecondSettlement) {
      const gain = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
      for (const hexId_ of vertex.hexes) {
        const hex = this.board.hexes.find((h) => h.id === hexId_);
        if (hex && hex.resource !== 'desert') gain[hex.resource] += 1;
      }
      addResources(player, gain);
      this._addLog(`${player.name} coloca su 2do poblado y recibe recursos iniciales.`);
    } else {
      this._addLog(`${player.name} coloca su 1er poblado.`);
    }

    this._recalcVictoryPoints(player);
    this.setupLastSettlementVertex = vertexId;
    this.setupSubStep = 'road';
    return { vertexId, player: player.id };
  }

  placeSetupRoad(playerId, edgeId) {
    this._assertCurrentSetupPlayer(playerId);
    this._assertPhase(PHASES.SETUP);
    if (this.setupSubStep !== 'road') {
      throw new GameError('Debes colocar un poblado primero', 'WRONG_SETUP_STEP');
    }
    const edge = this._getEdge(edgeId);
    if (edge.road) throw new GameError('Esa arista ya tiene un camino', 'EDGE_OCCUPIED');
    const touchesLastSettlement =
      edge.vertexA === this.setupLastSettlementVertex || edge.vertexB === this.setupLastSettlementVertex;
    if (!touchesLastSettlement) {
      throw new GameError('El camino inicial debe conectar con el poblado que acabas de colocar', 'ROAD_MUST_TOUCH_SETTLEMENT');
    }

    const player = this.getPlayer(playerId);
    edge.road = playerId;
    player.buildings.roads.push(edgeId);
    player.piecesLeft.road -= 1;
    this._addLog(`${player.name} coloca un camino inicial.`);

    this.setupStep += 1;
    this.setupSubStep = 'settlement';
    this.setupLastSettlementVertex = null;

    if (this.setupStep >= this.setupQueue.length) {
      this.phase = PHASES.ROLL;
      this.turnNumber = 1;
      this.currentPlayerIndex = 0;
      this._addLog('Colocación inicial completa. Comienza la partida.');
    }

    return { edgeId, player: player.id, setupComplete: this.phase !== PHASES.SETUP };
  }

  rollDice(playerId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.ROLL);

    const { d1, d2, total } = rollTwoDice(this.rng);
    this.lastDiceRoll = { d1, d2, total };
    this._addLog(`${this.currentPlayer.name} tira los dados: ${d1} + ${d2} = ${total}`);

    if (total === 7) {
      this._handleRollSeven();
    } else {
      this._distributeResources(total);
      this.phase = PHASES.MAIN;
    }

    return { d1, d2, total, phase: this.phase };
  }

  _distributeResources(diceTotal) {
    const hexesWithNumber = this.board.hexes.filter((h) => h.number === diceTotal && h.id !== this.robberHex);
    for (const hex of hexesWithNumber) {
      const vertexIds = this.board.hexVertices.get(hex.id);
      for (const vId of vertexIds) {
        const vertex = this.board.vertices.get(vId);
        if (!vertex.building) continue;
        const player = this.getPlayer(vertex.building.playerId);
        const amount = vertex.building.type === 'city' ? 2 : 1;
        if ((this.bank[hex.resource] || 0) >= amount) {
          addResources(player, { [hex.resource]: amount });
          this.bank[hex.resource] -= amount;
        }
      }
    }
  }

  _handleRollSeven() {
    this.pendingDiscards = this.players
      .filter((p) => totalResourceCount(p) > 7)
      .map((p) => p.id);
    if (this.pendingDiscards.length > 0) {
      this.phase = PHASES.DISCARD;
      this._addLog('Se sacó un 7. Los jugadores con más de 7 cartas deben descartar la mitad.');
    } else {
      this.phase = PHASES.MOVE_ROBBER;
      this._addLog('Se sacó un 7. El jugador en turno debe mover al ladrón.');
    }
  }

  discardResources(playerId, discard) {
    this._assertPhase(PHASES.DISCARD);
    if (!this.pendingDiscards.includes(playerId)) {
      throw new GameError('No tienes que descartar', 'NO_DISCARD_PENDING');
    }
    const player = this.getPlayer(playerId);
    const totalToDiscard = Object.values(discard).reduce((a, b) => a + b, 0);
    const required = Math.floor(totalResourceCount(player) / 2);
    if (totalToDiscard !== required) {
      throw new GameError(`Debes descartar exactamente ${required} cartas`, 'INVALID_DISCARD_COUNT');
    }
    if (!canAfford(player, discard)) {
      throw new GameError('No tienes esas cartas para descartar', 'INSUFFICIENT_RESOURCES');
    }
    deductResources(player, discard);
    for (const [res, amount] of Object.entries(discard)) this.bank[res] += amount;
    this.pendingDiscards = this.pendingDiscards.filter((id) => id !== playerId);
    this._addLog(`${player.name} descarta ${required} cartas.`);

    if (this.pendingDiscards.length === 0) {
      this.phase = PHASES.MOVE_ROBBER;
      this._addLog('Todos los descartes completos. El jugador en turno debe mover al ladrón.');
    }
    return { remaining: this.pendingDiscards.length };
  }

  moveRobber(playerId, targetHexId, victimPlayerId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MOVE_ROBBER);
    const hex = this.board.hexes.find((h) => h.id === targetHexId);
    if (!hex) throw new GameError('Hexágono inválido', 'INVALID_HEX');
    if (targetHexId === this.robberHex) {
      throw new GameError('El ladrón ya está ahí', 'ROBBER_SAME_HEX');
    }

    this.robberHex = targetHexId;

    const victimsAvailable = this._playersAdjacentToHex(targetHexId).filter((pid) => pid !== playerId);

    if (victimPlayerId) {
      if (!victimsAvailable.includes(victimPlayerId)) {
        throw new GameError('Ese jugador no tiene construcciones junto al ladrón', 'INVALID_VICTIM');
      }
      this._stealRandomCard(playerId, victimPlayerId);
    } else if (victimsAvailable.length > 0) {
      throw new GameError('Debes elegir una víctima entre los jugadores adyacentes', 'VICTIM_REQUIRED');
    }

    this.phase = PHASES.MAIN;
    this._addLog(`${this.currentPlayer.name} mueve al ladrón.`);
    return { robberHex: this.robberHex, victimsAvailable };
  }

  _playersAdjacentToHex(hexId_) {
    const vertexIds = this.board.hexVertices.get(hexId_) || [];
    const playerIds = new Set();
    for (const vId of vertexIds) {
      const vertex = this.board.vertices.get(vId);
      if (vertex.building) playerIds.add(vertex.building.playerId);
    }
    return [...playerIds];
  }

  _stealRandomCard(thiefId, victimId) {
    const victim = this.getPlayer(victimId);
    const thief = this.getPlayer(thiefId);
    const pool = [];
    for (const [res, amount] of Object.entries(victim.resources)) {
      for (let i = 0; i < amount; i++) pool.push(res);
    }
    if (pool.length === 0) return null;
    const idx = Math.floor(this.rng() * pool.length);
    const stolen = pool[idx];
    victim.resources[stolen] -= 1;
    thief.resources[stolen] = (thief.resources[stolen] || 0) + 1;
    this._addLog(`${thief.name} roba una carta a ${victim.name}.`);
    return stolen;
  }

  buildRoad(playerId, edgeId, { free = false } = {}) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);
    const edge = this._getEdge(edgeId);

    if (edge.road) throw new GameError('Esa arista ya tiene un camino', 'EDGE_OCCUPIED');
    if (player.piecesLeft.road <= 0) throw new GameError('No te quedan caminos disponibles', 'NO_PIECES_LEFT');
    if (!this._edgeConnectsToPlayerNetwork(edgeId, playerId)) {
      throw new GameError('El camino debe conectar con otro camino o construcción tuya', 'ROAD_NOT_CONNECTED');
    }
    if (!free) {
      if (!canAfford(player, BUILDING_COSTS.road)) throw new GameError('No tienes recursos suficientes', 'INSUFFICIENT_RESOURCES');
      deductResources(player, BUILDING_COSTS.road);
      this._returnToBank(BUILDING_COSTS.road);
    }

    edge.road = playerId;
    player.buildings.roads.push(edgeId);
    player.piecesLeft.road -= 1;
    this._addLog(`${player.name} construye un camino.`);
    this._recalcLongestRoad();
    this._recalcVictoryPoints(player);
    this._checkVictory();
    return { edgeId };
  }

  buildSettlement(playerId, vertexId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);

    this._assertVertexFreeAndLegal(vertexId, {});
    if (player.piecesLeft.settlement <= 0) throw new GameError('No te quedan poblados disponibles', 'NO_PIECES_LEFT');
    if (!this._vertexConnectsToPlayerRoad(vertexId, playerId)) {
      throw new GameError('El poblado debe conectar con un camino tuyo', 'SETTLEMENT_NOT_CONNECTED');
    }
    if (!canAfford(player, BUILDING_COSTS.settlement)) throw new GameError('No tienes recursos suficientes', 'INSUFFICIENT_RESOURCES');

    deductResources(player, BUILDING_COSTS.settlement);
    this._returnToBank(BUILDING_COSTS.settlement);

    const vertex = this._getVertex(vertexId);
    vertex.building = { playerId, type: 'settlement' };
    player.buildings.settlements.push(vertexId);
    player.piecesLeft.settlement -= 1;
    this._addLog(`${player.name} construye un poblado.`);
    this._recalcVictoryPoints(player);
    this._checkVictory();
    return { vertexId };
  }

  upgradeToCity(playerId, vertexId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);
    const vertex = this._getVertex(vertexId);

    if (!vertex.building || vertex.building.playerId !== playerId || vertex.building.type !== 'settlement') {
      throw new GameError('Debes tener un poblado propio en ese vértice', 'INVALID_CITY_UPGRADE');
    }
    if (player.piecesLeft.city <= 0) throw new GameError('No te quedan ciudades disponibles', 'NO_PIECES_LEFT');
    if (!canAfford(player, BUILDING_COSTS.city)) throw new GameError('No tienes recursos suficientes', 'INSUFFICIENT_RESOURCES');

    deductResources(player, BUILDING_COSTS.city);
    this._returnToBank(BUILDING_COSTS.city);

    vertex.building.type = 'city';
    player.buildings.settlements = player.buildings.settlements.filter((v) => v !== vertexId);
    player.buildings.cities.push(vertexId);
    player.piecesLeft.settlement += 1;
    player.piecesLeft.city -= 1;
    this._addLog(`${player.name} mejora un poblado a ciudad.`);
    this._recalcVictoryPoints(player);
    this._checkVictory();
    return { vertexId };
  }

  buyDevCard(playerId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);

    if (this.devCardDeck.length === 0) throw new GameError('No quedan cartas de desarrollo', 'DECK_EMPTY');
    if (!canAfford(player, BUILDING_COSTS.devCard)) throw new GameError('No tienes recursos suficientes', 'INSUFFICIENT_RESOURCES');

    deductResources(player, BUILDING_COSTS.devCard);
    this._returnToBank(BUILDING_COSTS.devCard);

    const cardType = this.devCardDeck.pop();
    player.devCards.push({ type: cardType, playable: false, boughtTurn: this.turnNumber });
    this._addLog(`${player.name} compra una carta de desarrollo.`);

    if (cardType === DEV_CARD_TYPES.VICTORY_POINT) {
      this._recalcVictoryPoints(player);
      this._checkVictory();
    }
    return { cardType };
  }

  playDevCard(playerId, cardType, options = {}) {
    this._assertCurrentPlayer(playerId);
    const player = this.getPlayer(playerId);
    const cardIdx = player.devCards.findIndex(
      (c) => c.type === cardType && c.playable !== false && c.boughtTurn !== this.turnNumber
    );
    if (cardIdx === -1) {
      throw new GameError('No tienes esa carta jugable (recién comprada o ya jugada esta jugada)', 'CARD_NOT_PLAYABLE');
    }
    if (cardType === DEV_CARD_TYPES.VICTORY_POINT) {
      throw new GameError('Las cartas de punto de victoria no se juegan, cuentan automáticamente', 'CANNOT_PLAY_VP_CARD');
    }

    player.devCards.splice(cardIdx, 1);

    switch (cardType) {
      case DEV_CARD_TYPES.KNIGHT:
        player.knightsPlayed += 1;
        this._recalcLargestArmy();
        this.phase = PHASES.MOVE_ROBBER;
        this._addLog(`${player.name} juega un Caballero.`);
        break;
      case DEV_CARD_TYPES.ROAD_BUILDING: {
        const { edgeIds } = options;
        if (!edgeIds || edgeIds.length === 0 || edgeIds.length > 2) {
          throw new GameError('Debes indicar 1 o 2 aristas para construir caminos gratis', 'INVALID_ROAD_BUILDING');
        }
        for (const edgeId of edgeIds) {
          this.buildRoad(playerId, edgeId, { free: true });
        }
        this._addLog(`${player.name} juega Construcción de caminos.`);
        break;
      }
      case DEV_CARD_TYPES.YEAR_OF_PLENTY: {
        const { resources } = options;
        if (!resources || Object.values(resources).reduce((a, b) => a + b, 0) !== 2) {
          throw new GameError('Debes elegir exactamente 2 recursos', 'INVALID_YEAR_OF_PLENTY');
        }
        addResources(player, resources);
        for (const [res, amount] of Object.entries(resources)) this.bank[res] -= amount;
        this._addLog(`${player.name} juega Año de Bonanza.`);
        break;
      }
      case DEV_CARD_TYPES.MONOPOLY: {
        const { resource } = options;
        if (!resource) throw new GameError('Debes elegir un recurso', 'INVALID_MONOPOLY');
        let total = 0;
        for (const other of this.players) {
          if (other.id === playerId) continue;
          total += other.resources[resource] || 0;
          other.resources[resource] = 0;
        }
        addResources(player, { [resource]: total });
        this._addLog(`${player.name} juega Monopolio sobre ${resource} y obtiene ${total} cartas.`);
        break;
      }
      default:
        throw new GameError('Tipo de carta desconocido', 'UNKNOWN_CARD');
    }
    this._checkVictory();
    return { cardType, phase: this.phase };
  }

  tradeWithBank(playerId, give, want) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);

    const giveResource = Object.keys(give)[0];
    const giveAmount = give[giveResource];
    const wantResource = Object.keys(want)[0];
    const wantAmount = want[wantResource];

    const rate = this._getTradeRate(playerId, giveResource);
    if (giveAmount !== rate || wantAmount !== 1) {
      throw new GameError(`La tasa de cambio es ${rate}:1 para ${giveResource}`, 'INVALID_TRADE_RATE');
    }
    if ((player.resources[giveResource] || 0) < giveAmount) {
      throw new GameError('No tienes suficientes recursos', 'INSUFFICIENT_RESOURCES');
    }
    if ((this.bank[wantResource] || 0) < wantAmount) {
      throw new GameError('El banco no tiene ese recurso disponible', 'BANK_EMPTY');
    }

    player.resources[giveResource] -= giveAmount;
    this.bank[giveResource] += giveAmount;
    player.resources[wantResource] += wantAmount;
    this.bank[wantResource] -= wantAmount;
    this._addLog(`${player.name} cambia ${giveAmount} ${giveResource} por ${wantAmount} ${wantResource} con el banco.`);
    return { give, want, rate };
  }

  _getTradeRate(playerId, resource) {
    const player = this.getPlayer(playerId);
    const ports = this.board.ports.filter(
      (p) =>
        (this._getVertex(p.vertexA).building?.playerId === playerId ||
          this._getVertex(p.vertexB).building?.playerId === playerId)
    );
    const hasSpecificPort = ports.some((p) => p.type === resource);
    if (hasSpecificPort) return 2;
    const hasGenericPort = ports.some((p) => p.type === 'generic');
    if (hasGenericPort) return 3;
    return 4;
  }

  proposeTrade(playerId, offer, request, targetPlayerIds) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);
    const player = this.getPlayer(playerId);
    if (!canAfford(player, offer)) throw new GameError('No tienes los recursos que ofreces', 'INSUFFICIENT_RESOURCES');
    const tradeId = `trade_${Date.now()}_${Math.floor(this.rng() * 10000)}`;
    this.pendingTrade = { tradeId, from: playerId, offer, request, targetPlayerIds, responses: {} };
    this._addLog(`${player.name} propone un intercambio.`);
    return { tradeId };
  }

  respondToTrade(playerId, tradeId, accept) {
    if (!this.pendingTrade || this.pendingTrade.tradeId !== tradeId) {
      throw new GameError('No hay una propuesta de intercambio activa con ese id', 'NO_PENDING_TRADE');
    }
    this.pendingTrade.responses[playerId] = accept;
    return { responses: this.pendingTrade.responses };
  }

  executeTrade(initiatorId, tradeId, acceptingPlayerId) {
    if (!this.pendingTrade || this.pendingTrade.tradeId !== tradeId) {
      throw new GameError('No hay una propuesta de intercambio activa con ese id', 'NO_PENDING_TRADE');
    }
    if (this.pendingTrade.responses[acceptingPlayerId] !== true) {
      throw new GameError('Ese jugador no aceptó el intercambio', 'TRADE_NOT_ACCEPTED');
    }
    const from = this.getPlayer(this.pendingTrade.from);
    const to = this.getPlayer(acceptingPlayerId);
    const { offer, request } = this.pendingTrade;

    if (!canAfford(from, offer) || !canAfford(to, request)) {
      throw new GameError('Alguno de los jugadores ya no tiene los recursos necesarios', 'INSUFFICIENT_RESOURCES');
    }
    deductResources(from, offer);
    deductResources(to, request);
    addResources(from, request);
    addResources(to, offer);
    this._addLog(`${from.name} y ${to.name} completan un intercambio.`);
    this.pendingTrade = null;
    return { ok: true };
  }

  endTurn(playerId) {
    this._assertCurrentPlayer(playerId);
    this._assertPhase(PHASES.MAIN);

    for (const player of this.players) {
      for (const card of player.devCards) {
        card.playable = true;
      }
    }

    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.turnNumber += 1;
    this.phase = PHASES.ROLL;
    this.lastDiceRoll = null;
    this._addLog(`Turno de ${this.currentPlayer.name}.`);
    return { currentPlayerId: this.currentPlayer.id, turnNumber: this.turnNumber };
  }

  _recalcVictoryPoints(player) {
    let points = 0;
    points += player.buildings.settlements.length * 1;
    points += player.buildings.cities.length * 2;
    points += player.devCards.filter((c) => c.type === DEV_CARD_TYPES.VICTORY_POINT).length * 1;
    if (player.hasLongestRoad) points += 2;
    if (player.largestArmy) points += 2;
    player.victoryPoints = points;
  }

  _recalcLargestArmy() {
    const eligiblePlayers = this.players.filter((p) => p.knightsPlayed >= 3);
    if (eligiblePlayers.length === 0) {
      for (const p of this.players) p.largestArmy = false;
      return;
    }
    const maxKnights = Math.max(...this.players.map((p) => p.knightsPlayed));
    const currentHolder = this.players.find((p) => p.largestArmy);
    for (const p of this.players) p.largestArmy = false;

    const candidates = this.players.filter((p) => p.knightsPlayed === maxKnights && maxKnights >= 3);
    if (candidates.length === 1) {
      candidates[0].largestArmy = true;
    } else if (currentHolder && currentHolder.knightsPlayed === maxKnights) {
      currentHolder.largestArmy = true;
    }
    for (const p of this.players) this._recalcVictoryPoints(p);
  }

  _recalcLongestRoad() {
    const lengths = {};
    for (const player of this.players) {
      lengths[player.id] = this._longestRoadForPlayer(player.id);
      player.longestRoadLength = lengths[player.id];
    }
    const maxLength = Math.max(...Object.values(lengths));
    if (maxLength < 5) {
      for (const p of this.players) p.hasLongestRoad = false;
    } else {
      const currentHolder = this.players.find((p) => p.hasLongestRoad);
      const candidates = this.players.filter((p) => lengths[p.id] === maxLength);
      for (const p of this.players) p.hasLongestRoad = false;
      if (candidates.length === 1) {
        candidates[0].hasLongestRoad = true;
      } else if (currentHolder && lengths[currentHolder.id] === maxLength) {
        currentHolder.hasLongestRoad = true;
      }
    }
    for (const p of this.players) this._recalcVictoryPoints(p);
  }

  _longestRoadForPlayer(playerId) {
    const playerEdges = [...this.board.edges.values()].filter((e) => e.road === playerId);
    if (playerEdges.length === 0) return 0;

    const adjacency = new Map();
    for (const edge of playerEdges) {
      if (!adjacency.has(edge.vertexA)) adjacency.set(edge.vertexA, []);
      if (!adjacency.has(edge.vertexB)) adjacency.set(edge.vertexB, []);
      adjacency.get(edge.vertexA).push({ to: edge.vertexB, edgeId: edge.id });
      adjacency.get(edge.vertexB).push({ to: edge.vertexA, edgeId: edge.id });
    }

    let best = 0;
    const startVertices = [...adjacency.keys()];

    for (const start of startVertices) {
      const visitedEdges = new Set();
      best = Math.max(best, this._dfsLongestPath(start, adjacency, visitedEdges, playerId));
    }
    return best;
  }

  _dfsLongestPath(vertexId, adjacency, visitedEdges, playerId) {
    let maxLen = 0;
    const vertex = this.board.vertices.get(vertexId);
    if (vertex.building && vertex.building.playerId !== playerId) {
      return 0;
    }
    const neighbors = adjacency.get(vertexId) || [];
    for (const { to, edgeId } of neighbors) {
      if (visitedEdges.has(edgeId)) continue;
      visitedEdges.add(edgeId);
      const len = 1 + this._dfsLongestPath(to, adjacency, visitedEdges, playerId);
      visitedEdges.delete(edgeId);
      maxLen = Math.max(maxLen, len);
    }
    return maxLen;
  }

  _checkVictory() {
    const winner = this.players.find((p) => p.victoryPoints >= VICTORY_POINTS_TO_WIN);
    if (winner) {
      this.winner = winner.id;
      this.phase = PHASES.GAME_OVER;
      this._addLog(`¡${winner.name} gana la partida con ${winner.victoryPoints} puntos de victoria!`);
    }
  }

  _getVertex(vertexId) {
    const v = this.board.vertices.get(vertexId);
    if (!v) throw new GameError('Vértice inválido', 'INVALID_VERTEX');
    return v;
  }

  _getEdge(edgeId) {
    const e = this.board.edges.get(edgeId);
    if (!e) throw new GameError('Arista inválida', 'INVALID_EDGE');
    return e;
  }

  _assertVertexFreeAndLegal(vertexId, { ignoreDistanceFromOwnRoad = false } = {}) {
    const vertex = this._getVertex(vertexId);
    if (vertex.building) throw new GameError('Ya hay una construcción en ese vértice', 'VERTEX_OCCUPIED');
    for (const adjId of vertex.adjacentVertices) {
      const adj = this.board.vertices.get(adjId);
      if (adj.building) {
        throw new GameError('Demasiado cerca de otra construcción (regla de distancia)', 'TOO_CLOSE_TO_BUILDING');
      }
    }
  }

  _edgeConnectsToPlayerNetwork(edgeId, playerId) {
    const edge = this._getEdge(edgeId);
    for (const vId of [edge.vertexA, edge.vertexB]) {
      const vertex = this.board.vertices.get(vId);
      if (vertex.building && vertex.building.playerId === playerId) return true;
      for (const adjId of vertex.adjacentVertices) {
        const edgeKey = [vId, adjId].sort().join('|');
        const adjEdge = this.board.edges.get(edgeKey);
        if (adjEdge && adjEdge.road === playerId) return true;
      }
    }
    return false;
  }

  _vertexConnectsToPlayerRoad(vertexId, playerId) {
    const vertex = this._getVertex(vertexId);
    for (const adjId of vertex.adjacentVertices) {
      const edgeKey = [vertexId, adjId].sort().join('|');
      const edge = this.board.edges.get(edgeKey);
      if (edge && edge.road === playerId) return true;
    }
    return false;
  }

  _returnToBank(cost) {
    for (const [res, amount] of Object.entries(cost)) {
      this.bank[res] += amount;
    }
  }

  _assertPhase(expected) {
    if (this.phase !== expected) {
      throw new GameError(`Acción no válida en la fase actual (${this.phase}), se esperaba ${expected}`, 'WRONG_PHASE');
    }
  }

  _assertCurrentPlayer(playerId) {
    if (this.currentPlayer.id !== playerId) {
      throw new GameError('No es tu turno', 'NOT_YOUR_TURN');
    }
  }

  _assertCurrentSetupPlayer(playerId) {
    if (this.currentSetupPlayerId() !== playerId) {
      throw new GameError('No es tu turno de colocación inicial', 'NOT_YOUR_SETUP_TURN');
    }
  }

  getPublicState(forPlayerId) {
    return {
      phase: this.phase,
      turnNumber: this.turnNumber,
      currentPlayerId: this.currentPlayer ? this.currentPlayer.id : null,
      currentSetupPlayerId: this.isSetupPhase() ? this.currentSetupPlayerId() : null,
      setupSubStep: this.isSetupPhase() ? this.setupSubStep : null,
      lastDiceRoll: this.lastDiceRoll,
      robberHex: this.robberHex,
      winner: this.winner,
      pendingDiscards: this.pendingDiscards,
      bank: { ...this.bank, devCardsLeft: this.devCardDeck.length },
      board: this._serializeBoard(),
      players: this.players.map((p) => this._serializePlayer(p, p.id === forPlayerId)),
      log: this.log.slice(-30),
    };
  }

  _serializeBoard() {
    return {
      hexes: this.board.hexes,
      vertices: [...this.board.vertices.values()].map((v) => ({
        id: v.id,
        x: v.x,
        y: v.y,
        building: v.building,
      })),
      edges: [...this.board.edges.values()].map((e) => ({
        id: e.id,
        vertexA: e.vertexA,
        vertexB: e.vertexB,
        road: e.road,
      })),
      ports: this.board.ports,
    };
  }

  _serializePlayer(player, isSelf) {
    const base = {
      id: player.id,
      name: player.name,
      color: player.color,
      piecesLeft: player.piecesLeft,
      buildings: player.buildings,
      knightsPlayed: player.knightsPlayed,
      hasLongestRoad: player.hasLongestRoad,
      largestArmy: player.largestArmy,
      victoryPoints: isSelf ? player.victoryPoints : this._publicVictoryPoints(player),
      resourceCount: totalResourceCount(player),
      devCardCount: player.devCards.length,
    };
    if (isSelf) {
      base.resources = { ...player.resources };
      base.devCards = player.devCards.map((c) => ({ ...c }));
    }
    return base;
  }

  _publicVictoryPoints(player) {
    let points = player.buildings.settlements.length * 1;
    points += player.buildings.cities.length * 2;
    if (player.hasLongestRoad) points += 2;
    if (player.largestArmy) points += 2;
    return points;
  }
}

module.exports = {
  CatanGame,
  GameError,
  PHASES,
  VICTORY_POINTS_TO_WIN,
  MIN_PLAYERS,
  MAX_PLAYERS,
  rollTwoDice,
};