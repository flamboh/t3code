import { expect, it } from "vite-plus/test";

import { isPullRequestWatchMatch, matchingPullRequestWatches } from "./pullRequestWatchMatch.ts";

const watches = [
  { number: 12, repository: "PingDotGG/T3Code" },
  { number: 34, repository: "pingdotgg/t3code" },
];

it("matches on number with a case-insensitive repository", () => {
  expect(isPullRequestWatchMatch(watches[0]!, { number: 12, repository: "pingdotgg/t3code" })).toBe(
    true,
  );
  expect(isPullRequestWatchMatch(watches[0]!, { number: 12, repository: "PINGDOTGG/T3CODE" })).toBe(
    true,
  );
});

it("rejects number or repository mismatches", () => {
  expect(isPullRequestWatchMatch(watches[0]!, { number: 99, repository: "pingdotgg/t3code" })).toBe(
    false,
  );
  expect(isPullRequestWatchMatch(watches[0]!, { number: 12, repository: "other/repo" })).toBe(
    false,
  );
});

it("falls back to a number-only match when the row has no repository", () => {
  for (const repository of [null, undefined, ""]) {
    expect(isPullRequestWatchMatch(watches[0]!, { number: 12, repository })).toBe(true);
    expect(isPullRequestWatchMatch(watches[0]!, { number: 99, repository })).toBe(false);
  }
});

it("collects every matching watch", () => {
  const withDuplicate = [...watches, { number: 12, repository: "pingdotgg/t3code" }];
  expect(
    matchingPullRequestWatches(withDuplicate, { number: 12, repository: "pingdotgg/t3code" }),
  ).toHaveLength(2);
  expect(
    matchingPullRequestWatches(watches, { number: 12, repository: "other/repo" }),
  ).toHaveLength(0);
});
