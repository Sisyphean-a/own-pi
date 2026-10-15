import { observationLineTokenCount } from "../../tokens.js";
import type { Observation } from "../../session-ledger/index.js";

export function observationTokenSum(observations: readonly Observation[]): number {
	return observations.reduce((sum, observation) => sum + observationLineTokenCount(observation), 0);
}

export function observationPoolFullness(observationTokens: number, targetTokens: number): number {
	return Number.isFinite(observationTokens) && observationTokens > 0 && Number.isFinite(targetTokens) && targetTokens > 0
		? observationTokens / targetTokens : 0;
}

export function observationPoolMetrics(observations: readonly Observation[], targetTokens: number) {
	const observationTokens = observationTokenSum(observations);
	const overTarget = Number.isFinite(targetTokens) && targetTokens >= 0 && observationTokens > targetTokens;
	return {
		observationTokens, targetTokens, tokensOverTarget: Math.max(0, observationTokens - targetTokens),
		fullness: observationPoolFullness(observationTokens, targetTokens),
		activeObservationCount: observations.length, overTarget, ready: overTarget,
	};
}
