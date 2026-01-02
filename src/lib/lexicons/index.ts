import { type AtprotoRefs, atprotoRefs, lexiconToValibot } from "@bigmistqke/lexicon-to-valibot";
import * as v from "valibot";
import projectLexicon from "./app.klip.project";
import stemLexicon from "./app.klip.stem";

// SDK format validators for parsing incoming data from PDS
const sdkOptions = { externalRefs: atprotoRefs, format: 'sdk' as const };
export const projectValidators = lexiconToValibot(projectLexicon, sdkOptions);
export const stemValidators = lexiconToValibot(stemLexicon, sdkOptions);

// Wire format validators for validating outgoing data to PDS
const wireOptions = { externalRefs: atprotoRefs, format: 'wire' as const };
export const projectWireValidators = lexiconToValibot(projectLexicon, wireOptions);
export const stemWireValidators = lexiconToValibot(stemLexicon, wireOptions);

// Types inferred from validators (satisfies preserves literal types without readonly)
export type Project = v.InferOutput<typeof projectValidators.main>;
export type Canvas = v.InferOutput<typeof projectValidators.canvas>;
export type Track = v.InferOutput<typeof projectValidators.track>;
export type Clip = v.InferOutput<typeof projectValidators.clip>;
export type StaticValue = v.InferOutput<typeof projectValidators.staticValue>;
export type CurveRef = v.InferOutput<typeof projectValidators.curveRef>;
export type StemRef = v.InferOutput<AtprotoRefs['com.atproto.repo.strongRef']>;

// Group types
export type Group = v.InferOutput<typeof projectValidators["group"]>;
export type Member = v.InferOutput<typeof projectValidators["member"]>;
export type MemberVoid = v.InferOutput<typeof projectValidators["member.void"]>;
export type LayoutGrid = v.InferOutput<typeof projectValidators["layout.grid"]>;

export type AudioEffectGain = v.InferOutput<typeof projectValidators["audioEffect.gain"]>;
export type AudioEffectPan = v.InferOutput<typeof projectValidators["audioEffect.pan"]>;
export type AudioEffectCustom = v.InferOutput<typeof projectValidators["audioEffect.custom"]>;
export type AudioEffect = AudioEffectGain | AudioEffectPan | AudioEffectCustom;

export type VisualEffectTransform = v.InferOutput<typeof projectValidators["visualEffect.transform"]>;
export type VisualEffectOpacity = v.InferOutput<typeof projectValidators["visualEffect.opacity"]>;
export type VisualEffectCustom = v.InferOutput<typeof projectValidators["visualEffect.custom"]>;
export type VisualEffect = VisualEffectTransform | VisualEffectOpacity | VisualEffectCustom;

export type CurveKeyframe = v.InferOutput<typeof projectValidators["curve.keyframe"]>;
export type CurveEnvelope = v.InferOutput<typeof projectValidators["curve.envelope"]>;
export type CurveLfo = v.InferOutput<typeof projectValidators["curve.lfo"]>;
export type Curve = CurveKeyframe | CurveEnvelope | CurveLfo;

export type Value = StaticValue | CurveRef;

export type Stem = v.InferOutput<typeof stemValidators.main>;
export type AudioMeta = v.InferOutput<typeof stemValidators.audioMeta>;
export type VideoMeta = v.InferOutput<typeof stemValidators.videoMeta>;

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
