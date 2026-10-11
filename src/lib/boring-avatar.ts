import * as BoringAvatarModule from 'boring-avatars';
import type { ComponentType } from 'react';

interface AvatarProps {
  name?: string;
  size?: number | string;
  variant?: 'marble' | 'beam' | 'pixel' | 'sunset' | 'ring' | 'bauhaus' | 'geometric' | 'abstract';
  colors?: string[];
  square?: boolean;
  title?: boolean;
  [key: string]: unknown;
}

/**
 * Boring-avatars ships only a UMD build with `exports.default`. Depending on the bundler's
 * CJS interop, the default import is either the component or `{ default: component }`.
 * Unwrap until we reach the component (fixes React error #130 under Vite).
 */
const unwrap = (mod: unknown): ComponentType<AvatarProps> => {
  let value = mod as { default?: unknown };
  while (value && 'function' !== typeof value && 'default' in value) {
    value = value.default as { default?: unknown };
  }
  return value as unknown as ComponentType<AvatarProps>;
};

const BoringAvatar = unwrap(BoringAvatarModule);

export default BoringAvatar;
