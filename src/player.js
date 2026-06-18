'use strict';

const RESOURCE_TYPES = ['wood', 'brick', 'wheat', 'sheep', 'ore'];

const DEV_CARD_TYPES = {
  KNIGHT: 'knight',
  ROAD_BUILDING: 'road_building',
  YEAR_OF_PLENTY: 'year_of_plenty',
  MONOPOLY: 'monopoly',
  VICTORY_POINT: 'victory_point',
};

const STANDARD_DEV_CARD_DECK = [
  ...Array(14).fill(DEV_CARD_TYPES.KNIGHT),
  ...Array(2).fill(DEV_CARD_TYPES.ROAD_BUILDING),
  ...Array(2).fill(DEV_CARD_TYPES.YEAR_OF_PLENTY),
  ...Array(2).fill(DEV_CARD_TYPES.MONOPOLY),
  ...Array(5).fill(DEV_CARD_TYPES.VICTORY_POINT),
];

const BUILDING_COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1 },
  city: { wheat: 2, ore: 3 },
  devCard: { wheat: 1, sheep: 1, ore: 1 },
};

const STARTING_PIECES = {
  roads: 15,
  settlements: 5,
  cities: 4,
};

function createPlayer(id, name, color) {
  return {
    id,
    name,
    color,
    resources: { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 },
    devCards: [],
    piecesLeft: { road: 15, settlement: 5, city: 4 },
    buildings: { roads: [], settlements: [], cities: [] },
    knightsPlayed: 0,
    victoryPoints: 0,
    hiddenVictoryPoints: 0,
    longestRoadLength: 0,
    isConnectedToLongestRoad: false,
    largestArmy: false,
    hasLongestRoad: false,
  };
}

function totalResourceCount(player) {
  return Object.values(player.resources).reduce((a, b) => a + b, 0);
}

function canAfford(player, cost) {
  return Object.entries(cost).every(([res, amount]) => (player.resources[res] || 0) >= amount);
}

function deductResources(player, cost) {
  for (const [res, amount] of Object.entries(cost)) {
    player.resources[res] -= amount;
  }
}

function addResources(player, gain) {
  for (const [res, amount] of Object.entries(gain)) {
    player.resources[res] = (player.resources[res] || 0) + amount;
  }
}

module.exports = {
  RESOURCE_TYPES,
  DEV_CARD_TYPES,
  STANDARD_DEV_CARD_DECK,
  BUILDING_COSTS,
  STARTING_PIECES,
  createPlayer,
  totalResourceCount,
  canAfford,
  deductResources,
  addResources,
};