import type { ImageContent as VendoredPiImageContent } from "../../../types/pi/packages/ai/src/types.js";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "../../../types/pi/packages/coding-agent/src/modes/rpc/rpc-types.js";

type AssertAssignable<From extends To, To> = true;

type LocalPiImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

type LocalElicitationRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    };

type LocalElicitationResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

type VendoredElicitationRequest = Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

type PiVendoredTypesMatch = [
  AssertAssignable<LocalPiImageContent, VendoredPiImageContent>,
  AssertAssignable<VendoredPiImageContent, LocalPiImageContent>,
  AssertAssignable<LocalElicitationRequest, VendoredElicitationRequest>,
  AssertAssignable<VendoredElicitationRequest, LocalElicitationRequest>,
  AssertAssignable<LocalElicitationResponse, RpcExtensionUIResponse>,
  AssertAssignable<RpcExtensionUIResponse, LocalElicitationResponse>,
];
