/**
 * Import recipes into the library from a list of URLs.
 *
 *   npm run recipes:import                          # data/recipe-urls.txt
 *   npm run recipes:import -- --file my-urls.txt
 *   npm run recipes:import -- --dry-run             # parse only, save nothing
 *
 * Parsing relies on schema.org Recipe markup, which most recipe sites publish.
 * Video and pin links have none and have to be entered by hand.
 */

import { readFileSync } from 'node:fs';
import { initDatabase } from '../db/connection.js';
import { runMigrations } from '../db/schema.js';
import { RecipeRepository } from '../db/repositories/recipe.repo.js';
import { RecipeParserService } from '../services/recipe-parser.service.js';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
}

async function main(): Promise<void> {
  const file = arg('--file', 'data/recipe-urls.txt')!;
  const dryRun = process.argv.includes('--dry-run');

  const urls = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (urls.length === 0) {
    console.error(`No URLs in ${file}`);
    process.exit(1);
  }

  const parser = new RecipeParserService();
  let repo: RecipeRepository | null = null;
  if (!dryRun) {
    const db = initDatabase();
    runMigrations(db);
    repo = new RecipeRepository(db);
  }

  const saved: string[] = [];
  const failed: string[] = [];

  for (const url of urls) {
    const recipe = await parser.parseFromUrl(url);
    if (!recipe) {
      failed.push(url);
      console.log(`  --  ${url}`);
      continue;
    }

    const time = (recipe.prepTimeMinutes ?? 0) + (recipe.cookTimeMinutes ?? 0);
    console.log(
      `  ok  ${recipe.title} — ${recipe.ingredients.length} ingredients, ` +
        `${time || '?'} min, serves ${recipe.servings ?? '?'}`
    );

    if (repo) repo.create(recipe);
    saved.push(recipe.title);
  }

  console.log(`\n${saved.length} recipe(s) ${dryRun ? 'parsed' : 'saved'}, ${failed.length} failed.`);
  if (failed.length) {
    console.log('\nCouldn\'t read these (no recipe markup, or the site blocked us):');
    for (const url of failed) console.log(`  ${url}`);
    console.log('\nAdd them by hand with the save_recipe tool, or re-run from a different network.');
  }
}

main().catch((error: unknown) => {
  console.error('\nRecipe import failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
