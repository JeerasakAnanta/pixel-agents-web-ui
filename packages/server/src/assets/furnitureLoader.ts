import type {
  FurnitureAsset,
  FurnitureManifest,
  InheritedProps,
  ManifestGroup,
} from '@pixel-agents/core/assets/manifestUtils.js';
import { flattenManifest } from '@pixel-agents/core/assets/manifestUtils.js';
import { pngToSpriteData } from '@pixel-agents/core/assets/pngDecoder.js';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export type { FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>;
}

export function mergeLoadedAssets(a: LoadedAssets, b: LoadedAssets): LoadedAssets {
  const bIds = new Set(b.catalog.map((item) => item.id));
  const dedupedA = a.catalog.filter((item) => !bIds.has(item.id));
  return {
    catalog: [...dedupedA, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  };
}

export async function loadFurnitureAssets(workspaceRoot: string): Promise<LoadedAssets | null> {
  try {
    console.log(`[AssetLoader] workspaceRoot received: "${workspaceRoot}"`);
    const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
    console.log(`[AssetLoader] Scanning furniture directory: ${furnitureDir}`);

    if (!fs.existsSync(furnitureDir)) {
      console.log('ℹ️  No furniture directory found at:', furnitureDir);
      return null;
    }

    const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) {
      console.log('ℹ️  No furniture subdirectories found');
      return null;
    }

    console.log(`📦 Found ${dirs.length} furniture folders`);

    const catalog: FurnitureAsset[] = [];
    const sprites = new Map<string, string[][]>();

    for (const dir of dirs) {
      const itemDir = path.join(furnitureDir, dir.name);
      const manifestPath = path.join(itemDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`  ⚠️  No manifest.json in ${dir.name}`);
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as FurnitureManifest;

        const inherited: InheritedProps = {
          groupId: manifest.id,
          name: manifest.name,
          category: manifest.category,
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
        };

        let assets: FurnitureAsset[];

        if (manifest.type === 'asset') {
          assets = [
            {
              id: manifest.id,
              name: manifest.name,
              label: manifest.name,
              category: manifest.category,
              file: manifest.file ?? `${manifest.id}.png`,
              width: manifest.width!,
              height: manifest.height!,
              footprintW: manifest.footprintW!,
              footprintH: manifest.footprintH!,
              isDesk: manifest.category === 'desks',
              canPlaceOnWalls: manifest.canPlaceOnWalls,
              canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
              backgroundTiles: manifest.backgroundTiles,
              groupId: manifest.id,
            },
          ];
        } else {
          if (manifest.rotationScheme) {
            inherited.rotationScheme = manifest.rotationScheme;
          }
          const rootGroup: ManifestGroup = {
            type: 'group',
            groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
            rotationScheme: manifest.rotationScheme,
            members: manifest.members!,
          };
          assets = flattenManifest(rootGroup, inherited);
        }

        for (const asset of assets) {
          try {
            const assetPath = path.join(itemDir, asset.file);
            const resolvedAsset = path.resolve(assetPath);
            const resolvedDir = path.resolve(itemDir);
            if (
              !resolvedAsset.startsWith(resolvedDir + path.sep) &&
              resolvedAsset !== resolvedDir
            ) {
              console.warn(
                `  [AssetLoader] Skipping asset with path outside directory: ${asset.file}`,
              );
              continue;
            }
            if (!fs.existsSync(assetPath)) {
              console.warn(`  ⚠️  Asset file not found: ${asset.file} in ${dir.name}`);
              continue;
            }

            const pngBuffer = fs.readFileSync(assetPath);
            const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
            sprites.set(asset.id, spriteData);
          } catch (err) {
            console.warn(
              `  ⚠️  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        catalog.push(...assets);
      } catch (err) {
        console.warn(
          `  ⚠️  Error processing ${dir.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(`  ✓ Loaded ${sprites.size} / ${catalog.length} assets`);
    console.log(`[AssetLoader] ✅ Successfully loaded ${sprites.size} furniture sprites`);

    return { catalog, sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading furniture assets: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function sendAssetsToWebview(webview: vscode.Webview, assets: LoadedAssets): void {
  if (!assets) {
    console.log('[AssetLoader] ⚠️  No assets to send');
    return;
  }

  console.log('[AssetLoader] Converting sprites Map to object...');
  const spritesObj: Record<string, string[][]> = {};
  for (const [id, spriteData] of assets.sprites) {
    spritesObj[id] = spriteData;
  }

  console.log(
    `[AssetLoader] Posting furnitureAssetsLoaded message with ${assets.catalog.length} assets`,
  );
  webview.postMessage({
    type: 'furnitureAssetsLoaded',
    catalog: assets.catalog,
    sprites: spritesObj,
  });

  console.log(`📤 Sent ${assets.catalog.length} furniture assets to webview`);
}
