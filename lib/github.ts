import { Octokit } from "octokit";

// A minimal structural type so helpers are testable with a fake.
export interface GitHubClient {
  rest: {
    pulls: {
      get(args: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          user: { login: string } | null;
          base: { ref: string };
          state: string;
        };
      }>;
      createReview(args: {
        owner: string;
        repo: string;
        pull_number: number;
        event: "APPROVE";
      }): Promise<unknown>;
    };
    users: {
      getAuthenticated(): Promise<{ data: { login: string } }>;
    };
  };
}

export function clientForToken(pat: string): GitHubClient {
  return new Octokit({ auth: pat }) as unknown as GitHubClient;
}

export async function getPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<{ author: string; baseRef: string }> {
  const { data } = await client.rest.pulls.get({ owner, repo, pull_number });
  return { author: data.user?.login ?? "", baseRef: data.base.ref };
}

// Fetch a PR, returning null if it doesn't exist (or isn't visible to this
// token). Used to probe several repos for a bare PR number.
export async function tryGetPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<{ author: string; baseRef: string; state: string } | null> {
  try {
    const { data } = await client.rest.pulls.get({ owner, repo, pull_number });
    return {
      author: data.user?.login ?? "",
      baseRef: data.base.ref,
      state: data.state,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function approve(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<void> {
  await client.rest.pulls.createReview({
    owner,
    repo,
    pull_number,
    event: "APPROVE",
  });
}

export async function getAuthenticatedLogin(
  client: GitHubClient,
): Promise<string> {
  const { data } = await client.rest.users.getAuthenticated();
  return data.login;
}
