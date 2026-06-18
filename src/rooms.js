'use strict';

const { CatanGame } = require('./game');

const PLAYER_COLORS = ['red', 'blue', 'white', 'orange'];
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.createdAt = Date.now();
    this.seats = [];
    this.game = null;
    this.status = 'lobby';
  }

  addSeat({ playerId, name, socketId }) {
    if (this.seats.length >= 4) {
      throw new Error('ROOM_FULL');
    }
    const usedColors = new Set(this.seats.map((s) => s.color));
    const color = PLAYER_COLORS.find((c) => !usedColors.has(c));
    const seat = { playerId, name, color, socketId, connected: true };
    this.seats.push(seat);
    return seat;
  }

  findSeatByPlayerId(playerId) {
    return this.seats.find((s) => s.playerId === playerId);
  }

  findSeatBySocketId(socketId) {
    return this.seats.find((s) => s.socketId === socketId);
  }

  canStart() {
    return this.seats.length >= 3 && this.status === 'lobby';
  }

  startGame() {
    if (!this.canStart()) {
      throw new Error('CANNOT_START');
    }
    const playerInfos = this.seats.map((s) => ({ id: s.playerId, name: s.name, color: s.color }));
    this.game = new CatanGame({ playerInfos });
    this.status = 'playing';
    return this.game;
  }

  allSeatsConnected() {
    return this.seats.every((s) => s.connected);
  }

  toLobbySummary() {
    return {
      code: this.code,
      status: this.status,
      seats: this.seats.map((s) => ({
        playerId: s.playerId,
        name: s.name,
        color: s.color,
        connected: s.connected,
      })),
      canStart: this.canStart(),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(hostSocketId) {
    const code = generateRoomCode(new Set(this.rooms.keys()));
    const room = new Room(code, hostSocketId);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  removeRoom(code) {
    this.rooms.delete(code);
  }

  cleanupStaleRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const ageMs = now - room.createdAt;
      const nobodyConnected = room.seats.length === 0 || room.seats.every((s) => !s.connected);
      if (nobodyConnected && ageMs > 30 * 60 * 1000) {
        this.rooms.delete(code);
      }
      if (room.status === 'finished' && ageMs > 2 * 60 * 60 * 1000) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { Room, RoomManager, generateRoomCode, PLAYER_COLORS };