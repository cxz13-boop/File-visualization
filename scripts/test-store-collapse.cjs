const assert = require("node:assert");
const { buildSync } = require("esbuild");

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

const result = buildSync({
  entryPoints: ["src/store.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});

const loaded = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(
  loaded,
  loaded.exports,
  require
);

const { useScanStore } = loaded.exports;
const store = useScanStore;
const nodes = [
  {
    id: "1",
    parentId: null,
    name: "root",
    path: "/1",
    kind: "dir",
    size: 0,
    totalSize: 0,
    childrenIds: ["2"],
    depth: 0,
    status: "loaded",
    modifiedAt: null,
  },
  {
    id: "2",
    parentId: "1",
    name: "two",
    path: "/1/2",
    kind: "dir",
    size: 0,
    totalSize: 0,
    childrenIds: ["3"],
    depth: 1,
    status: "loaded",
    modifiedAt: null,
  },
  {
    id: "3",
    parentId: "2",
    name: "three",
    path: "/1/2/3",
    kind: "dir",
    size: 0,
    totalSize: 0,
    childrenIds: ["4"],
    depth: 2,
    status: "loaded",
    modifiedAt: null,
  },
  {
    id: "4",
    parentId: "3",
    name: "four",
    path: "/1/2/3/4",
    kind: "file",
    size: 1,
    totalSize: 1,
    childrenIds: [],
    depth: 3,
    status: "loaded",
    modifiedAt: null,
  },
];

store.getState().setStarted({ path: "/1", rootId: "1", generation: 1 });
store.getState().addNodes(nodes);
store.getState().setExpandedMany(["1", "2", "3"], true, []);

let expanded = store.getState().expandedIds;
assert(expanded.has("1"), "root is expanded");
assert(expanded.has("2"), "node 2 is expanded");
assert(expanded.has("3"), "node 3 is expanded");

store.getState().setExpanded("2", false);
expanded = store.getState().expandedIds;
assert(expanded.has("1"), "root stays expanded after collapse");
assert(!expanded.has("2"), "collapsed node is removed");
assert(!expanded.has("3"), "descendant expansion is removed");

store.getState().setExpanded("2", true, []);
expanded = store.getState().expandedIds;
assert(expanded.has("1"), "root stays expanded after re-expand");
assert(expanded.has("2"), "node 2 is re-expanded");
assert(!expanded.has("3"), "re-expand does not restore node 3");

store.getState().setExpandedMany(["1", "2"], false, []);
expanded = store.getState().expandedIds;
assert(expanded.size === 0, "bulk collapse clears subtree expansion");

console.log("store collapse/re-expand regression test passed");
