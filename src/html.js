/**
 * Build-time HTML rewriting for encrypted (Level 1+) workloads.
 *
 * Elements carrying `data-ee` get their `data-ee-workload` resolved from a
 * workload *name* to its content *hash*, plus a `data-ee-key` for Level 1, and
 * the SDK script is appended to <body> if any such element was found.
 *
 * A Level 0 site — a normal blog or marketing site — has no `data-ee`
 * elements, so this is a no-op and no script is injected. That is intentional:
 * a static site should not pay for a runtime it does not use.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export function findHtmlFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findHtmlFiles(full, found);
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

function rehypeInjectEE(workloads, defaultWorkload, sdkUrl) {
  return () => (tree) => {
    let found = false;

    visit(tree, 'element', (node) => {
      if (!node.properties?.dataEe) return;
      found = true;
      const name = node.properties.dataEeWorkload || defaultWorkload;
      const workload = workloads[name];
      if (!workload) return;
      node.properties.dataEeWorkload = workload.hash;
      // Level 1 only, and decided here as well as at the point the key is
      // derived. This is the step that puts material into markup we ship, so it
      // enforces the rule rather than trusting its input: a Level 2 key
      // reaching the page would silently undo the gateway model, and nothing
      // downstream would report it (#262).
      //
      // Enforcing means removing, not merely declining to add. Suppressing the
      // assignment still leaves any data-ee-key that was already on the element
      // -- one an author copied from an example, or one this function wrote on
      // an earlier pass before the workload moved to Level 2 -- and that
      // attribute is exactly as readable to a browser as one we put there. The
      // first version of this guard only skipped the write, so it enforced the
      // rule for keys it produced and not for keys it inherited.
      //
      // `level` is absent on entries written by older builds; those only ever
      // carried a key for Level 1, so treating unknown as Level 1 keeps them
      // working without letting a Level 2 key through.
      const level = workload.level ?? 1;
      if (workload.key && level === 1) {
        node.properties.dataEeKey = workload.key;
      } else {
        delete node.properties.dataEeKey;
      }
    });

    if (!found || !sdkUrl) return;

    visit(tree, 'element', (node) => {
      if (node.tagName !== 'body' || !node.children) return;
      const present = node.children.some(
        (child) =>
          child.tagName === 'script' &&
          typeof child.properties?.src === 'string' &&
          child.properties.src.includes('ee.js'),
      );
      if (present) return;
      node.children.push({
        type: 'element',
        tagName: 'script',
        properties: { src: sdkUrl },
        children: [],
      });
    });
  };
}

export async function transformHtml(filePath, workloads, defaultWorkload, sdkUrl) {
  const original = readFileSync(filePath, 'utf8');
  const result = String(
    await unified()
      .use(rehypeParse)
      .use(rehypeInjectEE(workloads, defaultWorkload, sdkUrl))
      .use(rehypeStringify, { allowDangerousHtml: true })
      .process(original),
  );
  if (result === original) return false;
  writeFileSync(filePath, result);
  return true;
}
