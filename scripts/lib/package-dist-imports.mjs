// Scans packaged JavaScript for relative imports and missing closure entries.
import path from "node:path";
import { visitJavaScriptStatements } from "./javascript-statements.mjs";
const JS_FILE_RE = /\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasJavaScriptFileExtension(value) {
  return /\.(?:cjs|js|mjs)$/u.test(path.posix.basename(stripSpecifierSuffix(value)));
}

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis[0].value.cooked
    : undefined;
}

function appendImportEdges(source, importerPath, imports) {
  function visit(node) {
    let kind = "import";
    let specifier;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      specifier = literal(node.source);
    } else if (node.type === "ImportExpression") {
      specifier = literal(node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      kind = "require";
      specifier = literal(node.arguments[0]);
    } else if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "URL" &&
      node.arguments.length >= 2
    ) {
      const base = node.arguments[1];
      if (
        base.type === "MemberExpression" &&
        !base.computed &&
        base.property.type === "Identifier" &&
        base.property.name === "url" &&
        base.object.type === "MetaProperty" &&
        base.object.meta.name === "import" &&
        base.object.property.name === "meta"
      ) {
        kind = "import-meta-url";
        specifier = literal(node.arguments[0]);
      }
    }
    if (
      specifier?.startsWith(".") &&
      (kind !== "import-meta-url" || hasJavaScriptFileExtension(specifier))
    ) {
      const importedPath = path.posix.normalize(
        path.posix.join(
          path.posix.dirname(importerPath),
          kind === "require" ? specifier : stripSpecifierSuffix(specifier),
        ),
      );
      // stageManagedHandoffRuntime copies this entry and stages its private Koffi
      // closure before launch; this URL belongs to that runtime, not the tarball.
      const stagedNativeUrl =
        kind === "import-meta-url" &&
        importerPath === "dist/managed-handoff-runtime.mjs" &&
        importedPath === "dist/node_modules/koffi/indirect.cjs";
      if (!stagedNativeUrl && (kind !== "import-meta-url" || importedPath.startsWith("dist/"))) {
        imports.push({
          importerPath,
          importedPath,
          kind,
          ...(kind === "require" ? { specifier } : {}),
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            visit(child);
          }
        }
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  }
  visitJavaScriptStatements(
    source,
    {
      sourceType: importerPath.endsWith(".cjs") ? "script" : "module",
      allowReturnOutsideFunction: true,
    },
    (statements) => {
      for (const statement of statements) {
        visit(statement);
      }
    },
  );
}

function isPackagePath(value) {
  return !path.posix.isAbsolute(value) && value !== ".." && !value.startsWith("../");
}

// Node's default LOAD_AS_FILE / LOAD_AS_DIRECTORY rules, but only over archive entries.
// Host require.resolve() could accept omitted files or leave this package's inventory.
function resolveCommonJsImport(edge, fileSet, readText) {
  const target = edge.importedPath.replace(/\/$/u, "");
  if (!isPackagePath(target)) {
    return undefined;
  }
  const extensions = [".js", ".json", ".node"];
  const loadExtensions = (base) =>
    extensions.map((ext) => base + ext).find((file) => fileSet.has(file));
  const loadFile = (base) => (fileSet.has(base) ? base : loadExtensions(base));
  // A trailing slash or dot segment forces directory loading even when X.js exists.
  if (!/(?:\/|(?:^|\/)\.{1,2})$/u.test(edge.specifier)) {
    const file = loadFile(target);
    if (file) {
      return file;
    }
  }
  const manifestPath = path.posix.join(target, "package.json");
  if (fileSet.has(manifestPath)) {
    if (!readText) {
      throw new Error(`CommonJS import validation requires packaged metadata: ${manifestPath}`);
    }
    const manifest = JSON.parse(readText(manifestPath));
    const main = manifest?.main;
    if (typeof main === "string" && main) {
      const entry = path.posix.join(target, main).replace(/\/$/u, "");
      if (path.posix.isAbsolute(main) || !isPackagePath(entry)) {
        return undefined;
      }
      const file = loadFile(entry) ?? loadExtensions(path.posix.join(entry, "index"));
      if (file) {
        return file;
      }
    }
  }
  // Node retains the directory index fallback even for an invalid/missing main target.
  return loadExtensions(path.posix.join(target, "index"));
}

/** Collect missing-file errors for relative imports inside package files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });

  for (const edge of imports) {
    const { importerPath, importedPath } = edge;
    const resolved =
      edge.kind === "require"
        ? resolveCommonJsImport(edge, fileSet, params.readText)
        : fileSet.has(importedPath);
    if (!resolved) {
      errors.push(`${importerPath} imports missing ${importedPath}`);
    }
  }

  return errors;
}

/** Collect relative dist import edges from package JavaScript files. */
export function collectPackageDistImports(params) {
  const files =
    params.files.length === 1
      ? [normalizePackagePath(params.files[0])]
      : [...new Set(params.files.map(normalizePackagePath))].toSorted((left, right) =>
          left.localeCompare(right),
        );
  const imports = [];

  for (const importerPath of files) {
    if (!JS_FILE_RE.test(importerPath) || /(?:^|\/)node_modules\//u.test(importerPath)) {
      continue;
    }
    const source = params.readText(importerPath);
    appendImportEdges(source, importerPath, imports);
  }

  return imports;
}
