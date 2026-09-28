export type PackageDistImport = { importerPath: string; importedPath: string } & (
  | { kind: "import" | "import-meta-url" }
  | { kind: "require"; specifier: string }
);

export function collectPackageDistImportErrors(
  params: { files: readonly string[] } & (
    | {
        readText: (relativePath: string) => string;
        imports?: readonly PackageDistImport[];
      }
    | {
        imports: readonly PackageDistImport[];
        /** Required when a CommonJS directory import has a packaged package.json. */
        readText?: (relativePath: string) => string;
      }
  ),
): string[];

export function collectPackageDistImports(params: {
  files: readonly string[];
  readText: (relativePath: string) => string;
}): PackageDistImport[];
