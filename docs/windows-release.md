# Maintained Windows x64 PSC release

This source successor keeps the accepted PSC6175 transport, local PTY relay and cleanup implementation unchanged. The two dependency overlays are now tracked release inputs. They are not edits to an installed cache and are not published as official `@lydell` bytes.

`vendor/windows-pty-overlay/manifest.json` binds the exact locked wrapper and Windows x64 archive URLs, original SHA512 SRI and SHA256, complete original inventories, producer/upstream source correspondence, and the reviewed replacement/diff hashes. The source/recipe binding is not a reproducible native-binary attestation. All native PE/PDB files stay byte-identical. The agent replacement includes the accepted `windowsHide:true` and owned console-list cleanup; the terminal replacement includes the awaited completion bridge. They must produce exactly `87f349a7...` and `af35f5cd...`. Modified package files do not retain upstream archive SRI.

The checked installer validates the full five-file wrapper and 21-file platform inventory before writes. Only wholly original or wholly reviewed states are accepted. Unknown bytes, unexpected files, links, version mismatch and partial application fail before patching. Replacement payloads and review diffs are hash-checked. Resolved dependencies must stay inside the designated private installation root; a shared/hoisted dependency outside it is refused rather than modified. Each write is atomic; an ordinary commit failure rolls back committed files. A rollback failure is explicit and requires discarding the fresh staging directory. `--verify` accepts only the completed reviewed state. The script only resolves package entry paths; it never loads the Windows addon or executes a foreign PE.

## Source and normal release integration

1. Review this minimal packaging successor stacked on accepted6175 and integrate it through the project's normal source PR. No transport, credentials, pins, host records, native helper source or dist emitter changes are included.
2. Run the new packaging controls and existing normal CI on that source. Qualification already exists for the unchanged 88 dist files and Windows native closure; do not manufacture another native build. Attach the accepted Windows full Gateway lifecycle, quiet-process and post-client-exit owned-child absence receipts to release provenance. Exact public receipt paths must be supplied by root/Win35; this source writer does not replace those receipts with Linux tests.
3. Use an ordinary version/tag chosen by the release owner after checking publication state. This candidate remains version0.1.0 and is not published. A version bump must also update the product VERSION source and its emitted module under the normal reviewed release process; it is not performed in this packaging task.
4. The package includes the maintained script, manifest, exact2 JS payloads/diffs, and these instructions. Core's already qualified dist artifact is bundled so the sibling `file:../pocketshell-core` checkout is not required by a consumer. Commander12.1.0, ws8.22.0 and wrapper1.2.0-beta.15 match the accepted lock. The seven node-pty lock nodes and all non-root lock records remain unchanged.
5. Normal npm installation runs the maintained postinstall hook for Windows x64; other platforms are untouched. The protected Windows promotion below deliberately disables lifecycle hooks and invokes the same verified script directly with trusted Node, because npm's default Windows lifecycle shell is not the qualified quiet launcher.
6. For offline Windows fleet release material, stage the complete accepted88 dist, qualified Core/commander/ws and exact wrapper5/platform21 closure; carry this successor's package metadata, maintained script and vendor inputs. Generate a complete file manifest and release archive from that staging tree. Preserve the existing security helper lineage separately. The published PSC archive has its own integrity; the upstream SRI still denotes the original unmodified dependency archives only.

## Root-reviewed quiet Windows install/promotion

These are future owner actions; this packet performs no Windows installation or cutover.

The runtime owner first binds the current protected prefix, accepted Node and Microsoft SSH absolute paths/digests, helper dfac34251d1ff23fca8d4b77465c4674a611fd1fef733123747a21e5d0fa0da7, public version2 bindings and existing closed environment from the accepted public custody receipt. Do not invent paths from a login shell, PATH or a different host. Keep the account/config/runtime roots, DPAPI state, default host, pins, enrollment, gateway endpoint and per-device CLI/Bash policies unchanged.

Create a new owner-protected version directory beside the current package; retain the previous version for rollback. Verify the root-reviewed complete release archive/manifest before extraction. Extract only its regular inventory into that fresh directory with the owner's existing trusted native extractor, directly and hidden. Never patch the active installed package or a shared/global npm cache. For a normal npm tar installation, invoke the trusted Node executable with the absolute reviewed npm CLI JavaScript and `install --offline --ignore-scripts --no-audit --no-fund --prefix <fresh-protected-prefix> <reviewed-package.tgz>`, using only the already locked/custodied packages in an owned cache; no acquisition is authorized by this recipe. A complete portable fleet package needs no npm dependency resolution.

Invoke the maintained script with the same trusted Node using an argv array:

```
[trustedNode, freshPackage/scripts/apply-windows-pty-overlay.mjs,
 "--target-root", freshPrivateInstallRoot]
[trustedNode, freshPackage/scripts/apply-windows-pty-overlay.mjs,
 "--target-root", freshPrivateInstallRoot, "--verify"]
```

freshPrivateInstallRoot is the new owner-protected package/prefix containing those exact dependencies, never a shared global install root. A hoisted normal npm installation must use --ignore-scripts and the direct invocation against its fresh private prefix; it must not patch shared dependency storage.

Use the existing native launcher contract: absolute `FileName`, explicit argument list, `UseShellExecute=false`, `CreateNoWindow=true`, redirected stdout/stderr, bounded completion and checked natural exit. No cmd.exe, powershell.exe, npm.cmd, shell wrappers or profile aliases. The script output must be `state:verified`, and the complete manifest must match the approved release including unchanged native files and all88 dist files.

Version2 `windows-bindings.json` is runtime-owner provisioned under the new package's dist directory. Carry the exact existing helper/SSH/Node/systemRoot/systemDrive/programData values and digests unchanged. Only bind `entry` to the new protected absolute dist/cli.js and its reviewed hash; the helper's existing ACL/executable/realpath checks still apply. Do not copy or regenerate credentials, keys, account state, enrollment or host records. Do not relax foreign-file/ancestor ACL policy to make staging pass.

After root reviews the artifact and public cutover receipt, change only the owner's approved launcher/package selection to the new protected entry and matching public binding. The runtime invocation remains `[trustedNode, approvedEntry, ...supportedPSCArgs]` with the same verified closed environment. Keep endpoint/controller/guardian processes running. Reuse the accepted full Gateway lifecycle and quiet/owned-birth absence receipts for byte-identical runtime/native material; new release-specific checks concern file custody, bindings, launcher selection and native ACL authority. Actual new behavioral evidence is required only if a runtime byte/binding change introduces a cause, and belongs to the runtime owner.

Rollback selects the retained prior protected entry/binding; it does not revert account/profile state, kill a remote persistent session or restart an endpoint. A failed staging/check is never promotion success. The existing synchronous native ClosePseudoConsole limitation remains: the PSC eight-second asynchronous guard cannot preempt a blocking native close. Do not replace empirical owned-child absence evidence with that timer.
