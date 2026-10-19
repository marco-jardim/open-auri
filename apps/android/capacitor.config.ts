import type { CapacitorConfig } from '@capacitor/cli';
import { buildConfig } from './capacitor.targets.mjs';
import pkg from './package.json';

const config: CapacitorConfig = buildConfig(process.env, pkg.version);

export default config;
