import { type AtprotoRefs, atprotoRefs, lexiconToValibot } from "lexicon-to-valibot";
import * as v from "valibot";
import type { Mutable } from "~/utils";
import projectLexicon from "../../../lexicons/app.klip.project";
import stemLexicon from "../../../lexicons/app.klip.stem";

const options = { externalRefs: atprotoRefs };
export const projectValidators = lexiconToValibot(projectLexicon, options);
export const stemValidators = lexiconToValibot(stemLexicon, options);

// Types inferred from validators (satisfies preserves literal types without readonly)
export type Project = Mutable<v.InferOutput<typeof projectValidators.main>>;
export type Canvas = Mutable<v.InferOutput<typeof projectValidators.canvas>>;
export type Track = Mutable<v.InferOutput<typeof projectValidators.track>>;
export type Clip = Mutable<v.InferOutput<typeof projectValidators.clip>>;
export type StaticValue = Mutable<v.InferOutput<typeof projectValidators.staticValue>>;
export type CurveRef = Mutable<v.InferOutput<typeof projectValidators.curveRef>>;
export type StemRef = Mutable<v.InferOutput<AtprotoRefs['com.atproto.repo.strongRef']>>;

// Union types (inlined in lexicon, composed here for convenience)
export type GroupAbsolute = Mutable<v.InferOutput<typeof projectValidators["group.absolute"]>>;
export type GroupGrid = Mutable<v.InferOutput<typeof projectValidators["group.grid"]>>;
export type Group = GroupAbsolute | GroupGrid;

export type AudioEffectGain = Mutable<v.InferOutput<typeof projectValidators["audioEffect.gain"]>>;
export type AudioEffectPan = Mutable<v.InferOutput<typeof projectValidators["audioEffect.pan"]>>;
export type AudioEffectCustom = Mutable<v.InferOutput<typeof projectValidators["audioEffect.custom"]>>;
export type AudioEffect = AudioEffectGain | AudioEffectPan | AudioEffectCustom;

export type VisualEffectTransform = Mutable<v.InferOutput<typeof projectValidators["visualEffect.transform"]>>;
export type VisualEffectOpacity = Mutable<v.InferOutput<typeof projectValidators["visualEffect.opacity"]>>;
export type VisualEffectCustom = Mutable<v.InferOutput<typeof projectValidators["visualEffect.custom"]>>;
export type VisualEffect = VisualEffectTransform | VisualEffectOpacity | VisualEffectCustom;

export type CurveKeyframe = Mutable<v.InferOutput<typeof projectValidators["curve.keyframe"]>>;
export type CurveEnvelope = Mutable<v.InferOutput<typeof projectValidators["curve.envelope"]>>;
export type CurveLfo = Mutable<v.InferOutput<typeof projectValidators["curve.lfo"]>>;
export type Curve = CurveKeyframe | CurveEnvelope | CurveLfo;

export type Value = StaticValue | CurveRef;

export type Stem = Mutable<v.InferOutput<typeof stemValidators.main>>;
export type AudioMeta = Mutable<v.InferOutput<typeof stemValidators.audioMeta>>;
export type VideoMeta = Mutable<v.InferOutput<typeof stemValidators.videoMeta>>;

// Validation helpers
export function parseProject(data: unknown): Project {
  return v.parse(projectValidators.main, data);
}

export function parseProjectSafe(data: unknown): v.SafeParseResult<typeof projectValidators.main> {
  return v.safeParse(projectValidators.main, data);
}

export function parseStem(data: unknown): Stem {
  return v.parse(stemValidators.main, data);
}

export function parseStemSafe(data: unknown): v.SafeParseResult<typeof stemValidators.main> {
  return v.safeParse(stemValidators.main, data);
}
