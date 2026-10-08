// Fixed managed label definitions (#3, resources/labels-v1.json) plus Wave: 1..200. Names come from label-policy.
import {readFileSync} from 'node:fs';
import {LIMITS, StrictReader, type Decoded} from './contracts.js';
import {FIXED_LABEL_NAMES, waveLabelName} from './label-policy.js';
import {taggedDigest} from './digests.js';

export interface LabelDefinition { name: string; color: string; description: string }
interface LabelResource { version: 1; fixed: LabelDefinition[]; wave: {color: string; description: string} }

function decodeResource(value: unknown): Decoded<LabelResource> {
  const r = new StrictReader();
  const o = r.object(value, '', ['version', 'fixed', 'wave']) ?? {};
  r.literal(o.version, 'version', [1] as const, 'UNKNOWN_VERSION');
  const def = (v: unknown, p: string): LabelDefinition => {
    const d = r.object(v, p, ['name', 'color', 'description']) ?? {};
    return {name: r.text(d.name, `${p}.name`), color: r.pattern(d.color, `${p}.color`, x => typeof x === 'string' && /^[0-9a-f]{6}$/.test(x), 'six lowercase hex digits'), description: r.text(d.description, `${p}.description`)};
  };
  const fixed = r.array(o.fixed, 'fixed', def);
  const w = r.object(o.wave, 'wave', ['color', 'description']) ?? {};
  const wave = {color: r.pattern(w.color, 'wave.color', x => typeof x === 'string' && /^[0-9a-f]{6}$/.test(x), 'six lowercase hex digits'), description: r.text(w.description, 'wave.description')};
  if (fixed.map(d => d.name).join('\n') !== FIXED_LABEL_NAMES.join('\n')) r.add('INVALID_VALUE', 'fixed', 'Fixed labels must be exactly the canonical names in order.');
  return r.result({version: 1, fixed, wave});
}

const resource = (() => {
  const decoded = decodeResource(JSON.parse(readFileSync(new URL('../../../resources/labels-v1.json', import.meta.url), 'utf8')));
  if (!decoded.ok) throw new Error('resources/labels-v1.json is invalid: ' + decoded.problems.map(p => `${p.path} ${p.code}`).join(', '));
  return decoded.value;
})();

export const FIXED_LABEL_DEFINITIONS: readonly LabelDefinition[] = Object.freeze(resource.fixed.map(d => Object.freeze({...d})));
/** Throws for anything but an integer 1..200; never builds arbitrary label names. */
export function waveLabelDefinition(wave: number): LabelDefinition {
  return {name: waveLabelName(wave), color: resource.wave.color, description: resource.wave.description.replace('{n}', String(wave))};
}
export function labelDefinitions(): LabelDefinition[] {
  const waves = Array.from({length: LIMITS.waveMax - LIMITS.waveMin + 1}, (_, i) => waveLabelDefinition(LIMITS.waveMin + i));
  return [...FIXED_LABEL_DEFINITIONS.map(d => ({...d})), ...waves];
}
export const definitionsDigest = (): string => taggedDigest('label-definitions', labelDefinitions());
