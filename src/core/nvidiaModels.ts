// Single source of truth lives in scripts/setup-lib.mjs so the CLI setup script and the extension agree.
// @ts-ignore plain ESM helper
import { PREFERRED as P, NVIDIA_BASE_URL as U, pickModels as pick } from '../../scripts/setup-lib.mjs';

export interface PreferredModel {
  model_id: string;
  name: string;
  context_length: number;
  max_output_tokens: number;
}
export const PREFERRED: PreferredModel[] = P;
export const NVIDIA_BASE_URL: string = U;
export const pickModels: (available: string[]) => { models: PreferredModel[]; chain: string[] } = pick;
