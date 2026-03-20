import type { GitInfo as VendoredGitInfo } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/GitInfo.js";
import type { GitInfo } from "./protocol.js";

type AssertAssignable<From extends To, To> = true;

type GitInfoMatchesVendored = [
  AssertAssignable<GitInfo, VendoredGitInfo>,
  AssertAssignable<VendoredGitInfo, GitInfo>,
];
