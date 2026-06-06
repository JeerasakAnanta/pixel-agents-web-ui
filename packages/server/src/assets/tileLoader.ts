import { WALL_BITMASK_COUNT } from '@pixel-agents/core/assets/constants.js';
import { decodeFloorPng, parseWallPng } from '@pixel-agents/core/assets/pngDecoder.js';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export interface LoadedWallTiles {
  sets: string[][][][];
}

export interface LoadedFloorTiles {
  sprites: string[][][];
}

export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    if (!fs.existsSync(wallsDir)) {
      console.log('[AssetLoader] No walls/ directory found at:', wallsDir);
      return null;
    }

    console.log('[AssetLoader] Loading wall tiles from:', wallsDir);

    const entries = fs.readdirSync(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) {
        wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (wallFiles.length === 0) {
      console.log('[AssetLoader] No wall_N.png files found in walls/');
      return null;
    }

    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const filePath = path.join(wallsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprites = parseWallPng(pngBuffer);
      sets.push(sprites);
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${sets.length} wall tile set(s) (${sets.length * WALL_BITMASK_COUNT} pieces total)`,
    );
    return { sets };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading wall tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function sendWallTilesToWebview(webview: vscode.Webview, wallTiles: LoadedWallTiles): void {
  webview.postMessage({
    type: 'wallTilesLoaded',
    sets: wallTiles.sets,
  });
  console.log(`📤 Sent ${wallTiles.sets.length} wall tile set(s) to webview`);
}

export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    if (!fs.existsSync(floorsDir)) {
      console.log('[AssetLoader] No floors/ directory found at:', floorsDir);
      return null;
    }

    console.log('[AssetLoader] Loading floor tiles from:', floorsDir);

    const entries = fs.readdirSync(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) {
        floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (floorFiles.length === 0) {
      console.log('[AssetLoader] No floor_N.png files found in floors/');
      return null;
    }

    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      const filePath = path.join(floorsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprite = decodeFloorPng(pngBuffer);
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] ✅ Loaded ${sprites.length} floor tile patterns from floors/`);
    return { sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading floor tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function sendFloorTilesToWebview(
  webview: vscode.Webview,
  floorTiles: LoadedFloorTiles,
): void {
  webview.postMessage({
    type: 'floorTilesLoaded',
    sprites: floorTiles.sprites,
  });
  console.log(`📤 Sent ${floorTiles.sprites.length} floor tile patterns to webview`);
}
