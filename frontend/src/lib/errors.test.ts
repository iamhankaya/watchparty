import { expect, test } from "vitest";
import { describeConnectionError, toUserError } from "./errors";

test("sunucu mesajını HubException'dan çıkarır", () =>
  expect(describeConnectionError(new Error("An unexpected error occurred invoking 'JoinLobby' on the server. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
test("İngilizce SignalR metnini genel mesaja çevirir", () =>
  expect(describeConnectionError(new Error("Cannot send data if the connection is not in the 'Connected' State."))).toBe("Sunucuyla bağlantı kesildi"));
test("undefined için genel mesaj", () => expect(describeConnectionError(undefined)).toBe("Sunucuyla bağlantı kesildi"));
test("sunucunun kapatma mesajındaki HubException metni", () =>
  expect(describeConnectionError(new Error("Server returned an error on close: Connection closed with an error. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
test("verilen yedek mesajı kullanır", () =>
  expect(describeConnectionError(new Error("English"), "Sunucuya bağlanılamadı")).toBe("Sunucuya bağlanılamadı"));
test("toUserError: HubException mesajını olduğu gibi bırakır", () => {
  const e = new Error("An unexpected error occurred invoking 'Play' on the server. HubException: Sadece host kontrol edebilir");
  expect(toUserError(e)).toBe(e);
});
test("toUserError: İngilizce SignalR hatasını Türkçe genel mesaja çevirir", () => {
  const out = toUserError(new Error("Cannot send data if the connection is not in the 'Connected' State."));
  expect(out).toBeInstanceOf(Error);
  expect((out as Error).message).toBe("Sunucuyla bağlantı kesildi");
});
