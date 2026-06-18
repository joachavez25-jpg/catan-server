'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { GameError } = require('./game');

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'catan-server', rooms: roomManager.rooms.size });
});
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
});

const roomManager = new RoomManager();

setInterval(() => roomManager.cleanupStaleRooms(), 5 * 60 * 1000);

function broadcastRoomLobby(room) {
  io.to(room.code).emit('lobby:update', room.toLobbySummary());
}

function broadcastGameState(room) {
  for (const seat of room.seats) {
    if (!seat.connected) continue;
    const state = room.game.getPublicState(seat.playerId);
    io.to(seat.socketId).emit('game:state', state);
  }
}

function emitError(socket, error) {
  const message = error instanceof GameError ? error.message : 'Ocurrió un error inesperado';
  const code = error instanceof GameError ? error.code : 'UNKNOWN_ERROR';
  socket.emit('game:error', { message, code });
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  socket.on('room:create', ({ playerName }, callback) => {
    try {
      const room = roomManager.createRoom(socket.id);
      const playerId = `p_${socket.id}`;
      const seat = room.addSeat({ playerId, name: playerName || 'Jugador 1', socketId: socket.id });
      currentRoomCode = room.code;
      currentPlayerId = playerId;
      socket.join(room.code);
      callback({ ok: true, roomCode: room.code, playerId, color: seat.color });
      broadcastRoomLobby(room);
    } catch (err) {
      callback({ ok: false, error: 'No se pudo crear la sala' });
    }
  });

  socket.on('room:join', ({ roomCode, playerName, rejoinPlayerId }, callback) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) {
      return callback({ ok: false, error: 'Sala no encontrada. Verifica el código.' });
    }

    if (rejoinPlayerId) {
      const existingSeat = room.findSeatByPlayerId(rejoinPlayerId);
      if (existingSeat) {
        existingSeat.socketId = socket.id;
        existingSeat.connected = true;
        currentRoomCode = room.code;
        currentPlayerId = rejoinPlayerId;
        socket.join(room.code);
        callback({
          ok: true,
          roomCode: room.code,
          playerId: rejoinPlayerId,
          color: existingSeat.color,
          gameInProgress: room.status === 'playing',
        });
        broadcastRoomLobby(room);
        if (room.status === 'playing') {
          const state = room.game.getPublicState(rejoinPlayerId);
          socket.emit('game:state', state);
          socket.emit('game:started');
        }
        return;
      }
    }

    if (room.status !== 'lobby') {
      return callback({ ok: false, error: 'La partida ya comenzó, no se pueden unir nuevos jugadores.' });
    }
    if (room.seats.length >= 4) {
      return callback({ ok: false, error: 'La sala ya está llena (4/4 jugadores).' });
    }

    try {
      const playerId = `p_${socket.id}`;
      const seat = room.addSeat({ playerId, name: playerName || `Jugador ${room.seats.length + 1}`, socketId: socket.id });
      currentRoomCode = room.code;
      currentPlayerId = playerId;
      socket.join(room.code);
      callback({ ok: true, roomCode: room.code, playerId, color: seat.color });
      broadcastRoomLobby(room);
    } catch (err) {
      callback({ ok: false, error: 'No se pudo unir a la sala' });
    }
  });

  socket.on('room:start', (_, callback) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return callback?.({ ok: false, error: 'Sala no encontrada' });
    if (room.hostSocketId !== socket.id) {
      return callback?.({ ok: false, error: 'Solo el anfitrión puede iniciar la partida' });
    }
    try {
      room.startGame();
      callback?.({ ok: true });
      io.to(room.code).emit('game:started');
      broadcastGameState(room);
    } catch (err) {
      callback?.({ ok: false, error: 'No se puede iniciar: se necesitan 3 o 4 jugadores' });
    }
  });

  const gameActions = {
    'setup:settlement': (game, pid, p) => game.placeSetupSettlement(pid, p.vertexId),
    'setup:road': (game, pid, p) => game.placeSetupRoad(pid, p.edgeId),
    'dice:roll': (game, pid) => game.rollDice(pid),
    'discard': (game, pid, p) => game.discardResources(pid, p.discard),
    'robber:move': (game, pid, p) => game.moveRobber(pid, p.targetHexId, p.victimPlayerId || null),
    'build:road': (game, pid, p) => game.buildRoad(pid, p.edgeId),
    'build:settlement': (game, pid, p) => game.buildSettlement(pid, p.vertexId),
    'build:city': (game, pid, p) => game.upgradeToCity(pid, p.vertexId),
    'devcard:buy': (game, pid) => game.buyDevCard(pid),
    'devcard:play': (game, pid, p) => game.playDevCard(pid, p.cardType, p.options || {}),
    'trade:bank': (game, pid, p) => game.tradeWithBank(pid, p.give, p.want),
    'trade:propose': (game, pid, p) => game.proposeTrade(pid, p.offer, p.request, p.targetPlayerIds),
    'trade:respond': (game, pid, p) => game.respondToTrade(pid, p.tradeId, p.accept),
    'trade:execute': (game, pid, p) => game.executeTrade(pid, p.tradeId, p.acceptingPlayerId),
    'turn:end': (game, pid) => game.endTurn(pid),
  };

  socket.on('game:action', ({ action, payload }, callback) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.game) {
      return callback?.({ ok: false, error: 'No hay partida activa' });
    }
    const handler = gameActions[action];
    if (!handler) {
      return callback?.({ ok: false, error: 'Acción desconocida: ' + action });
    }
    try {
      const result = handler(room.game, currentPlayerId, payload || {});
      callback?.({ ok: true, result });
      broadcastGameState(room);

      if (action === 'trade:propose') {
        const targets = payload.targetPlayerIds || room.seats.map((s) => s.playerId);
        for (const seat of room.seats) {
          if (targets.includes(seat.playerId) && seat.playerId !== currentPlayerId) {
            io.to(seat.socketId).emit('trade:proposed', {
              tradeId: result.tradeId,
              from: currentPlayerId,
              offer: payload.offer,
              request: payload.request,
            });
          }
        }
      }

      if (room.game.phase === 'game_over') {
        room.status = 'finished';
        io.to(room.code).emit('game:over', { winner: room.game.winner });
      }
    } catch (err) {
      emitError(socket, err);
      callback?.({ ok: false, error: err.message, code: err.code });
    }
  });

  socket.on('chat:message', ({ text }) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return;
    const seat = room.findSeatBySocketId(socket.id);
    if (!seat || !text || !text.trim()) return;
    io.to(room.code).emit('chat:message', {
      playerId: seat.playerId,
      name: seat.name,
      text: text.trim().slice(0, 500),
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return;
    const seat = room.findSeatBySocketId(socket.id);
    if (seat) {
      seat.connected = false;
      broadcastRoomLobby(room);
      io.to(room.code).emit('player:disconnected', { playerId: seat.playerId, name: seat.name });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor de Catan escuchando en puerto ${PORT}`);
});

module.exports = { app, server, io, roomManager };