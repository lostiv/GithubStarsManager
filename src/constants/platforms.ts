export const VALID_PLATFORMS = ['mac', 'windows', 'linux', 'ios', 'android', 'docker', 'web', 'cli'] as const;

export type Platform = typeof VALID_PLATFORMS[number];

export const VALID_PLATFORMS_JSON = JSON.stringify(VALID_PLATFORMS);
