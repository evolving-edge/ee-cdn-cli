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
      if (workload.key) node.properties.dataEeKey = workload.key;
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
