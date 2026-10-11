import { expect, test } from "vitest";
import { describeConnectionError } from "./errors";

test("sunucu mesajını HubException'dan çıkarır", () =>
  expect(describeConnectionError(new Error("An unexpected error occurred invoking 'JoinLobby' on the server. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
test("İngilizce SignalR metnini genel mesaja çevirir", () =>
  expect(describeConnectionError(new Error("Cannot send data if the connection is not in the 'Connected' State."))).toBe("Sunucuyla bağlantı kesildi"));
test("undefined için genel mesaj", () => expect(describeConnectionError(undefined)).toBe("Sunucuyla bağlantı kesildi"));
test("sunucunun kapatma mesajındaki HubException metni", () =>
  expect(describeConnectionError(new Error("Server returned an error on close: Connection closed with an error. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
