# Consumer verification

Use the host project's commands rather than imposing the xapiforge repository's `pnpm verify` command on a consumer.

## Minimum evidence

Collect all applicable evidence:

1. Dependency installation completed without creating a second lockfile.
2. `xapiforge-fetch` succeeded, or offline mode found every expected OpenAPI snapshot.
3. `xapiforge <project-id>` generated the expected service and type files.
4. A second `xapiforge <project-id> --check` reports no drift when generated artifacts are committed.
5. The generated factory can be imported from consumer source, including the correct kebab-case service property mapping.
6. Representative canonical/service namespace types and runtime enum metadata compile.
7. Consumer TypeScript checking passes.
8. Consumer production build passes.
9. One safe generated request succeeds against an allowed backend or controlled mock and reaches the intended runtime host.
10. A representative failure is handled according to the consumer's error policy.
11. Authentication storage and refresh are exercised when authentication is in scope.
12. Native dependency sync/link and a platform build are exercised when a native adapter is in scope.
13. The consumer's dependency audit is run when required by its project policy; unresolved findings are reported without an unreviewed automatic fix.

## Diagnose by stage

### Installation failure

Check the selected registry, package version, lockfile, Node version, and whether the consumer accidentally installed framework plugins as xapiforge peer dependencies. Do not switch package managers to make the error disappear.

### Download failure

Confirm the resolved URL without printing credentials. Separate DNS, TLS, proxy, authentication, HTTP status, and timeout failures. Switch to offline mode only when a reviewed local snapshot exists.

### Generation failure

Validate that the input is self-contained OpenAPI 3.x and identify the exact service source. Compare the document with actual JSON before changing it. For a confirmed non-standard schema, implement a conservative service `transformSwagger` or runtime-enum `preprocessSwagger` hook and add a focused fixture. `transformTypes` must consume `ctx.normalizedDocument`, not reread the original file. Do not patch generated output.

### Type failure

Check the generated service name, path, HTTP method, params location, request body, and response type. A compile error may reveal that the frontend assumption differs from the backend document; do not cast it away before checking the contract.

### Runtime failure

Distinguish CORS, certificate, network, HTTP, authentication, business-envelope, and parsing failures. Inspect `ApiError.response`, status, normalized body, and cause without exposing sensitive data.

### Refresh loop

Confirm that login and refresh use plain fetch or `HttpClient`, not the authenticated generated client. Check that access and refresh tokens use distinct stores and that `onAuthFailed` does not immediately start another protected request.

## Completion report

Use a short evidence-based handoff:

```text
Changed: <files and behavior>
Generated: <project/services/output>
Passed: <commands>
Observed: <real or mock request and outcome>
Not run: <item and reason>
Remaining: <external dependency or risk>
```

Do not report “fully integrated” if the only evidence is installation, generated files, or static type checking.
