import roomProtocolFactory from '../../shared/net/room-protocol.js';

const container = {};
roomProtocolFactory(container);
const shared = container.exports;

export const ROOM_PROTOCOL_VERSION = shared.ROOM_PROTOCOL_VERSION;
export const ROOM_CODE_LENGTH = shared.ROOM_CODE_LENGTH;
export const MAX_DISPLAY_NAME_CODE_POINTS = shared.MAX_DISPLAY_NAME_CODE_POINTS;
export const MAX_REQUEST_ID_LENGTH = shared.MAX_REQUEST_ID_LENGTH;
export const MAX_TOKEN_LENGTH = shared.MAX_TOKEN_LENGTH;
export const ROOM_CODE_PATTERN = shared.ROOM_CODE_PATTERN;
export const ROOM_STATUS = shared.ROOM_STATUS;
export const MAX_CONTACT_OFFSET = shared.MAX_CONTACT_OFFSET;
export const MAX_ELEVATION = shared.MAX_ELEVATION;
export const CLIENT_MESSAGE_TYPES = shared.CLIENT_MESSAGE_TYPES;
export const normalizeDisplayName = shared.normalizeDisplayName;
export const normalizeRoomCode = shared.normalizeRoomCode;
export const formatRoomCode = shared.formatRoomCode;
export const validateRoomId = shared.validateRoomId;
export const validateClientMessage = shared.validateClientMessage;
