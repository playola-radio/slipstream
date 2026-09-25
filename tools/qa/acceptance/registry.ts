/** The acceptance-module registry. Each PR registers its module here by id. */
import type { AcceptanceModule } from './types.ts';
import { tqa } from './T-QA.ts';
import { t01 } from './T0.1.ts';
import { t02 } from './T0.2.ts';
import { t5a1 } from './T5a.1.ts';
import { t5a3 } from './T5a.3.ts';
import { t5b1 } from './T5b.1.ts';
import { f1Ask } from './F1-ask.ts';
import { f2Delivery } from './F2-delivery.ts';

export const MODULES: readonly AcceptanceModule[] = [tqa, t01, t02, t5a1, t5a3, t5b1, f1Ask, f2Delivery];
