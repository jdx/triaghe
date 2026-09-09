import { graphql, rest } from './gh.mjs';

/**
 * The only function in this project that writes to GitHub.
 *
 * It takes the stored draft body and posts it verbatim. It never reads the item
 * body, so no instruction embedded in an issue or discussion can reach this
 * code path — the worst a poisoned draft can do is produce text that sat on the
 * board and was approved by hand first.
 */
export async function postComment(env, item, body) {
  if (!body?.trim()) throw new Error('refusing to post an empty comment');

  if (item.kind === 'discussion') {
    if (!item.node_id) throw new Error('missing discussion node id; re-run ingest');
    const data = await graphql(
      env,
      `mutation($id: ID!, $body: String!) {
         addDiscussionComment(input: { discussionId: $id, body: $body }) {
           comment { url }
         }
       }`,
      { id: item.node_id, body },
      // Marks transport failures and 5xx as ambiguous rather than failed, so a
      // lost response cannot be retried into a duplicate discussion reply.
      { write: true },
    );
    return data.addDiscussionComment.comment.url;
  }

  const [owner, repo] = item.repo.split('/');
  const created = await rest(
    env, 'POST', `/repos/${owner}/${repo}/issues/${item.number}/comments`, { body },
  );
  return created.html_url;
}
