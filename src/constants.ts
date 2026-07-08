// World layout. WORLD_HEIGHT must stay 128: chunk indexing packs y into 7 bits.
export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 128;
export const SEA_LEVEL = 62;
export const MAX_LIGHT = 15;

// Physics (units are blocks/meters and seconds, matching vanilla feel)
export const GRAVITY = 32;
export const TERMINAL_VELOCITY = 78;
export const JUMP_SPEED = 9.0;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.612;
export const SNEAK_SPEED = 1.31;
export const SWIM_SPEED = 2.2;
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const SNEAK_HEIGHT = 1.65;
export const EYE_HEIGHT = 1.62;
export const SNEAK_EYE_HEIGHT = 1.27;

// Interaction
export const BLOCK_REACH = 4.5;
export const ATTACK_REACH = 3.0;
export const PLACE_REPEAT_S = 0.25;

// Survival stats
export const MAX_HEALTH = 20;
export const MAX_FOOD = 20;
export const MAX_AIR = 15; // seconds of breath
export const FALL_SAFE_BLOCKS = 3;

// Rendering / time. Vanilla: full cycle = 20 real minutes.
export const DAY_LENGTH_S = 1200;
export const DEFAULT_RENDER_DISTANCE = 7; // in chunks

// Persistence
export const WORLDS_INDEX_KEY = 'mc-worlds-v1';
export const WORLD_KEY_PREFIX = 'mc-world-';
export const OPTIONS_KEY = 'mc-options-v1';
