/**
 * Room wire protocol shared by the browser client and the Node room service.
 * Pure data and validation only: no DOM, no Node built-ins, no transport.
 */
export default function roomProtocolModule(module) {
  const ROOM_PROTOCOL_VERSION = 1;
  const ROOM_CODE_LENGTH = 6;
  const MAX_DISPLAY_NAME_CODE_POINTS = 10;
  const MAX_REQUEST_ID_LENGTH = 64;
  const MAX_TOKEN_LENGTH = 128;
  const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
  // The strike point may sit off centre for side spin and follow/draw. Past this
  // fraction of a ball radius the tip would miss the ball entirely.
  const MAX_CONTACT_OFFSET = 0.72;
  // The cue may be raised slightly; a larger angle belongs to a jump shot.
  const MAX_ELEVATION = 0.7853981633974483;
  const ROOM_STATUS = Object.freeze({
    WAITING: 'waiting',
    READY: 'ready',
    PLAYING: 'playing',
    FINISHED: 'finished',
    CLOSED: 'closed',
  });

  const CLIENT_MESSAGE_TYPES = Object.freeze([
    'room.create',
    'room.join',
    'room.ready',
    'room.start',
    'room.leave',
    'room.resume',
    'room.state',
    'match.place',
    'match.shot',
    'match.state',
    'match.rematch',
  ]);

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isNonEmptyString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  /** A 3D vector of finite numbers, used by the full-cue strike point. */
  function isVector3(value) {
    return (
      isRecord(value) &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z)
    );
  }

  function invalid(code, message) {
    return { ok: false, error: { code, message } };
  }

  function normalizeDisplayName(value) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        error: { code: 'invalid_name', message: 'displayName must be a string' },
      };
    }
    const name = value.trim();
    if (name.length === 0) {
      return { ok: false, error: { code: 'invalid_name', message: 'displayName is required' } };
    }
    if (Array.from(name).length > MAX_DISPLAY_NAME_CODE_POINTS) {
      return {
        ok: false,
        error: { code: 'invalid_name', message: 'displayName is too long' },
      };
    }
    for (let index = 0; index < name.length; index += 1) {
      const code = name.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) {
        return {
          ok: false,
          error: { code: 'invalid_name', message: 'displayName contains control characters' },
        };
      }
    }
    return { ok: true, value: name };
  }

  function validateRoomId(value) {
    return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
  }

  /** Room codes are stored uppercase; pasted spaces and hyphens are presentation only. */
  function normalizeRoomCode(value) {
    if (typeof value !== 'string') {
      return { ok: false, error: { code: 'invalid_room_id', message: 'roomId must be a string' } };
    }
    const code = value.toUpperCase().replace(/[\s-]+/gu, '');
    if (!validateRoomId(code)) {
      return {
        ok: false,
        error: { code: 'invalid_room_id', message: 'roomId must be six letters or digits' },
      };
    }
    return { ok: true, value: code };
  }

  function formatRoomCode(code) {
    return String(code).slice(0, 3) + ' ' + String(code).slice(3);
  }

  function validateIdentity(message) {
    if (!validateRoomId(message.roomId)) {
      return invalid('invalid_room_id', 'roomId must be six uppercase letters or digits');
    }
    if (!isNonEmptyString(message.playerId, 64)) {
      return invalid('invalid_player_id', 'playerId is required');
    }
    if (!isNonEmptyString(message.token, MAX_TOKEN_LENGTH) || message.token.length < 8) {
      return invalid('invalid_token', 'token is required');
    }
    return null;
  }

  /** Validate and normalize one client message. Unknown fields are ignored. */
  function validateClientMessage(input) {
    if (!isRecord(input)) {
      return invalid('invalid_message', 'message must be an object');
    }
    if (input.v !== ROOM_PROTOCOL_VERSION) {
      return invalid('unsupported_version', 'protocol version must be ' + ROOM_PROTOCOL_VERSION);
    }
    if (!CLIENT_MESSAGE_TYPES.includes(input.type)) {
      return invalid('unknown_type', 'unsupported message type');
    }
    if (!isNonEmptyString(input.requestId, MAX_REQUEST_ID_LENGTH)) {
      return invalid('invalid_request_id', 'requestId is required');
    }
    const base = {
      v: ROOM_PROTOCOL_VERSION,
      type: input.type,
      requestId: input.requestId,
    };
    if (input.type === 'room.create' || input.type === 'room.join') {
      const name = normalizeDisplayName(input.displayName);
      if (!name.ok) {
        return name;
      }
      if (input.type === 'room.join' && !validateRoomId(input.roomId)) {
        return invalid('invalid_room_id', 'roomId must be six uppercase letters or digits');
      }
      const message = { ...base, displayName: name.value };
      if (input.type === 'room.join') {
        message.roomId = input.roomId;
      } else if (input.interior !== undefined) {
        if (!isNonEmptyString(input.interior, 64)) {
          return invalid('invalid_interior', 'interior must be a scene id');
        }
        message.interior = input.interior;
      }
      return { ok: true, message };
    }
    const identityError = validateIdentity(input);
    if (identityError) {
      return identityError;
    }
    const message = {
      ...base,
      roomId: input.roomId,
      playerId: input.playerId,
      token: input.token,
    };
    if (input.type === 'room.ready') {
      if (typeof input.ready !== 'boolean') {
        return invalid('invalid_ready', 'ready must be a boolean');
      }
      message.ready = input.ready;
      return { ok: true, message };
    }
    if (input.type.startsWith('room.')) {
      return { ok: true, message };
    }
    if (!isNonEmptyString(input.matchId, 64)) {
      return invalid('invalid_match_id', 'matchId is required');
    }
    message.matchId = input.matchId;
    if (input.type === 'match.state' || input.type === 'match.rematch') {
      return { ok: true, message };
    }
    if (!isNonEmptyString(input.commandId, 64)) {
      return invalid('invalid_command_id', 'commandId is required');
    }
    if (!isNonNegativeInteger(input.matchVersion)) {
      return invalid('invalid_match_version', 'matchVersion must be a non-negative integer');
    }
    if (!isNonNegativeInteger(input.turn)) {
      return invalid('invalid_turn', 'turn must be a non-negative integer');
    }
    message.commandId = input.commandId;
    message.matchVersion = input.matchVersion;
    message.turn = input.turn;
    if (input.type === 'match.place') {
      if (
        !isRecord(input.position) ||
        !Number.isFinite(input.position.x) ||
        !Number.isFinite(input.position.z)
      ) {
        return invalid('invalid_position', 'position must contain finite x and z');
      }
      message.position = { x: input.position.x, z: input.position.z };
      return { ok: true, message };
    }
    if (
      !isRecord(input.shot) ||
      !isRecord(input.shot.direction) ||
      !Number.isFinite(input.shot.direction.x) ||
      !Number.isFinite(input.shot.direction.z) ||
      Math.hypot(input.shot.direction.x, input.shot.direction.z) < 1e-9 ||
      !Number.isFinite(input.shot.power) ||
      input.shot.power < 0 ||
      input.shot.power > 1
    ) {
      return invalid('invalid_shot', 'shot requires a finite direction and power between 0 and 1');
    }
    message.shot = {
      direction: { x: input.shot.direction.x, z: input.shot.direction.z },
      power: input.shot.power,
    };
    // Optional full cue: the client's strike point on the cue ball and the cue
    // axis. The service validates the geometry and still computes the impulse
    // itself, so side spin and follow/draw cannot smuggle in extra speed.
    if (input.shot.kiss !== undefined) {
      const { kiss, axis } = input.shot;
      if (!isVector3(kiss) || !isVector3(axis)) {
        return invalid('invalid_shot', 'shot.kiss and shot.axis must be finite 3D vectors');
      }
      const axisLength = Math.hypot(axis.x, axis.y, axis.z);
      if (axisLength < 1e-6) {
        return invalid('invalid_shot', 'shot.axis must not be zero');
      }
      message.shot.kiss = { x: kiss.x, y: kiss.y, z: kiss.z };
      message.shot.axis = {
        x: axis.x / axisLength,
        y: axis.y / axisLength,
        z: axis.z / axisLength,
      };
    }
    return { ok: true, message };
  }

  const api = {
    ROOM_PROTOCOL_VERSION,
    ROOM_CODE_LENGTH,
    MAX_DISPLAY_NAME_CODE_POINTS,
    MAX_REQUEST_ID_LENGTH,
    MAX_TOKEN_LENGTH,
    ROOM_CODE_PATTERN,
    ROOM_STATUS,
    MAX_CONTACT_OFFSET,
    MAX_ELEVATION,
    CLIENT_MESSAGE_TYPES,
    normalizeDisplayName,
    normalizeRoomCode,
    formatRoomCode,
    validateRoomId,
    validateClientMessage,
  };
  if (module) {
    module.exports = api;
  }
  return api;
}
