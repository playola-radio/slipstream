/** The acceptance-module registry. Each PR registers its module here by id. */
import type { AcceptanceModule } from './types.ts';
import { tqa } from './T-QA.ts';

export const MODULES: readonly AcceptanceModule[] = [tqa];

export function getModule(id: string): AcceptanceModule | undefined {
  return MODULES.find((m) => m.id === id);
}

export function moduleIds(): string[] {
  return MODULES.map((m) => m.id);
}
