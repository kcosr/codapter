import type { GitInfo as VendoredGitInfo } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/GitInfo.js";
import type { SessionSource as VendoredSessionSource } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/SessionSource.js";
import type { Thread as VendoredThread } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/Thread.js";
import type { ThreadItem as VendoredThreadItem } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.js";
import type { ThreadStatus as VendoredThreadStatus } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStatus.js";
import type { Turn as VendoredTurn } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/Turn.js";
import type { TurnError as VendoredTurnError } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnError.js";
import type { TurnStatus as VendoredTurnStatus } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnStatus.js";
import type { UserInput as VendoredUserInput } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.js";
import type {
  GitInfo,
  SessionSource,
  Thread,
  ThreadItem,
  ThreadStatus,
  Turn,
  TurnError,
  TurnStatus,
  UserInput,
} from "./protocol.js";

type AssertAssignable<From extends To, To> = true;

type GitInfoMatchesVendored = [
  AssertAssignable<GitInfo, VendoredGitInfo>,
  AssertAssignable<VendoredGitInfo, GitInfo>,
];

type SessionSourceMatchesVendored = [
  AssertAssignable<SessionSource, VendoredSessionSource>,
  AssertAssignable<VendoredSessionSource, SessionSource>,
];

type ThreadStatusMatchesVendored = [
  AssertAssignable<ThreadStatus, VendoredThreadStatus>,
  AssertAssignable<VendoredThreadStatus, ThreadStatus>,
];

type UserInputMatchesVendored = [
  AssertAssignable<UserInput, VendoredUserInput>,
  AssertAssignable<VendoredUserInput, UserInput>,
];

type ThreadItemMatchesVendored = [
  AssertAssignable<ThreadItem, VendoredThreadItem>,
  AssertAssignable<VendoredThreadItem, ThreadItem>,
];

type TurnStatusMatchesVendored = [
  AssertAssignable<TurnStatus, VendoredTurnStatus>,
  AssertAssignable<VendoredTurnStatus, TurnStatus>,
];

type TurnErrorMatchesVendored = [
  AssertAssignable<TurnError, VendoredTurnError>,
  AssertAssignable<VendoredTurnError, TurnError>,
];

type TurnMatchesVendored = [
  AssertAssignable<Turn, VendoredTurn>,
  AssertAssignable<VendoredTurn, Turn>,
];

type ThreadMatchesVendored = [
  AssertAssignable<Thread, VendoredThread>,
  AssertAssignable<VendoredThread, Thread>,
];
