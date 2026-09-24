/** The acceptance-module registry. Each PR registers its module here by id. */
import type { AcceptanceModule } from './types.ts';
import { tqa } from './T-QA.ts';
import { t01 } from './T0.1.ts';

export const MODULES: readonly AcceptanceModule[] = [tqa, t01];
