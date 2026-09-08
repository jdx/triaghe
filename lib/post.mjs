import { graphql, rest } from './gh.mjs';

/**
 * The only function in this project that writes to GitHub.
 *
 * It takes the stored draft body and posts it verbatim. It does not read the
 * item body, so no instruction embedded in an issue or discussion can reach
 * this code path — the worst a poisoned draft can do is produce text that
 * showed up on the board and was approved by hand first.
 */
export async function postComment(item, body) {
  if (!body?.trim()) throw new Error('refusing to post an empty comment');

  if (item.kind === 'discussion') {
    if (!item.node_id) throw new Error('missing discussion node id; re-run ingest');
    const data = await graphql(
      `mutation($id: ID!, $body: String!) {
         addDiscussionComment(input: { discussionId: $id, body: $body }) {
           comment { url }
         }
       }`,
      { id: item.node_id, body },
    );
    return data.addDiscussionComment.comment.url;
  }

  const [owner, repo] = item.repo.split('/');
  const created = await rest('POST', `/repos/${owner}/${repo}/issues/${item.number}/comments`, { body });
  return created.html_url;
}
