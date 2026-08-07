# Consumer verification

Use the host project's commands rather than imposing the xapiforge repository's `pnpm verify` command on a consumer.

## Minimum evidence

Collect all applicable evidence:

1. Dependency installation completed without creating a second lockfile.
2. `xapiforge-fetch` succeeded, or offline mode found every expected OpenAPI snapshot.
3. `xapiforge <project-id>` generated the expected service and type files.
4. The generated factory can be imported from consumer source.
5. Consumer TypeScript checking passes.
6. Consumer production build passes.
7. One safe generated request succeeds against an allowed backend or controlled mock.
8. A representative failure is handled according to the consumer's error policy.
9. Authentication storage and refresh are exercised when authentication is in scope.
10. Native dependency sync/link and a platform build are exercised when a native adapter is in scope.
11. The consumer's dependency audit is run when required by its project policy; unresolved findings are reported without an unreviewed automatic fix.

## Diagnose by stage

### Installation failure

Check the selected registry, package version, lockfile, Node version, and whether the consumer accidentally installed framework plugins as xapiforge peer dependencies. Do not switch package managers to make the error disappear.

### Download failure

Confirm the resolved URL without printing credentials. Separate DNS, TLS, proxy, authentication, HTTP status, and timeout failures. Switch to offline mode only when a reviewed local snapshot exists.

### Generation failure

Validate that the input is OpenAPI 3.x and identify the exact service file. For non-standard schemas, implement a consumer `transformSwagger` or `transformTypes` hook and add a focused fixture. Do not patch generated output.

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
