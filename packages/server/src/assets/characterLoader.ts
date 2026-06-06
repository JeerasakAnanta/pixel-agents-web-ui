import { CHAR_COUNT, CHAR_FRAMES_PER_ROW } from '@pixel-agents/core/assets/constants.js';
import { decodeCharacterPng } from '@pixel-agents/core/assets/pngDecoder.js';
import type { CharacterDirectionSprites } from '@pixel-agents/core/assets/types.js';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export type { CharacterDirectionSprites };

export interface LoadedCharacterSprites {
  characters: CharacterDirectionSprites[];
}

export function mergeCharacterSprites(
  a: LoadedCharacterSprites,
  b: LoadedCharacterSprites,
): LoadedCharacterSprites {
  return { characters: [...a.characters, ...b.characters] };
}

export async function loadCharacterSprites(
  assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) {
        console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
        return null;
      }

      const pngBuffer = fs.readFileSync(filePath);
      characters.push(decodeCharacterPng(pngBuffer));
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames × 3 directions each)`,
    );
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export async function loadExternalCharacterSprites(
  externalRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(externalRoot, 'assets', 'characters');
    if (!fs.existsSync(charDir)) {
      return null;
    }

    const entries = fs.readdirSync(charDir);
    const charFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^char_(\d+)\.png$/i.exec(entry);
      if (match) {
        charFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (charFiles.length === 0) {
      return null;
    }

    charFiles.sort((a, b) => a.index - b.index);

    const characters: CharacterDirectionSprites[] = [];
    for (const { filename } of charFiles) {
      const filePath = path.join(charDir, filename);
      const resolvedFile = path.resolve(filePath);
      const resolvedDir = path.resolve(charDir);
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        console.warn(`  [AssetLoader] Skipping character with path outside directory: ${filename}`);
        continue;
      }
      try {
        const pngBuffer = fs.readFileSync(filePath);
        characters.push(decodeCharacterPng(pngBuffer));
      } catch (err) {
        console.warn(
          `  [AssetLoader] ⚠️  Error loading character ${filename}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (characters.length === 0) {
      return null;
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${characters.length} external character sprites from ${externalRoot}`,
    );
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading external character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function sendCharacterSpritesToWebview(
  webview: vscode.Webview,
  charSprites: LoadedCharacterSprites,
): void {
  webview.postMessage({
    type: 'characterSpritesLoaded',
    characters: charSprites.characters,
  });
  console.log(`📤 Sent ${charSprites.characters.length} character sprites to webview`);
}
