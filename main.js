require("dotenv").config();
const { Telegraf } = require("telegraf");
const LocalSession = require("telegraf-session-local");
const axios = require("axios");
const cheerio = require("cheerio");
const { TelegramClient, Api } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const input = require("input");

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 1_200_000,
});

const sessionStorage = new LocalSession({
  database: "sessions.json",
  format: {
    serialize: (obj) => JSON.stringify(obj, null, 2),
    deserialize: (str) => JSON.parse(str),
  },
});

bot.use(sessionStorage.middleware());

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

let userClient = null;
let clientReady = false;

async function setupTelegramClient() {
  const session = new StoreSession("user_session");

  userClient = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await userClient.connect();

  if (await userClient.isUserAuthorized()) {
    console.log("Telegram account already logged in");
    clientReady = true;
    return;
  }

  console.log("Need to login...");
  await userClient.start({
    phoneNumber: async () => await input.text("Phone number (+7...): "),
    password: async () => await input.text("2FA password (if any): "),
    phoneCode: async () => await input.text("Code from Telegram: "),
    onError: (err) => console.log("Login error:", err),
  });

  console.log("Login completed");
  clientReady = true;
}

setupTelegramClient().catch(console.error);

const SITE = "https://tg-all.com";

function waitABit(min = 2800, spread = 5200) {
  const delay = min + Math.random() * spread;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function extractRealLink(pageUrl) {
  if (!pageUrl || !pageUrl.includes("/linck/")) return null;

  try {
    await waitABit(1200, 2800);

    const { data } = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 24000,
    });

    const $ = cheerio.load(data);

    let link =
      $('a[href^="https://t.me/"]').first().attr("href") ||
      $('a[href*="t.me/"]').first().attr("href");

    if (link && link.includes("t.me/")) {
      const m = link.match(/t\.me\/([^\/?#]+)/);
      if (m?.[1]) return `t.me/${m[1]}`;
    }

    const tgUri = $('a[href^="tg://"]').first().attr("href");
    if (tgUri) {
      const domain = tgUri.match(/domain=([^&?]+)/)?.[1];
      if (domain) return `t.me/${domain}`;

      const hash = tgUri.match(/invite\/([A-Za-z0-9_-]+)/)?.[1];
      if (hash) return `t.me/+${hash}`;
    }

    return null;
  } catch (err) {
    console.error(`Failed to parse link from ${pageUrl}: ${err.message}`);
    return null;
  }
}

async function findGroups(searchText, limit = 5) {
  let collected = [];
  let currentPage = 1;
  let shouldStop = false;

  const groupWords = [
    "чат",
    "группа",
    "группе",
    "группу",
    "сообщество",
    "общение",
    "обсуждение",
    "разговор",
    "болтаем",
    "тусовка",
    "клуб",
    "комната",
    "поддержка",
    "вопросы",
    "помощь",
    "знакомства",
    "chat",
    "group",
    "community",
    "discussion",
    "talk",
    "room",
    "club",
    "support",
    "help",
    "questions",
    "q&a",
  ];

  const channelWords = [
    "канал",
    "канале",
    "новости",
    "новость",
    "лента",
    "feed",
    "анонсы",
    "уведомления",
    "официальный",
    "channel",
    "news",
    "official",
    "announcements",
    "updates",
    "blog",
    "media",
  ];

  while (!shouldStop && collected.length < limit) {
    const url = `${SITE}/?filter=group&search=${encodeURIComponent(searchText)}&search_type=all&search_in=both&page=${currentPage}`;

    try {
      await waitABit(4800, 7400);

      const { data } = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        timeout: 30000,
      });

      const $ = cheerio.load(data);
      let foundOnPage = 0;

      for (const item of $(".recommended-channel")) {
        if (collected.length >= limit) {
          shouldStop = true;
          break;
        }

        const $item = $(item);

        const name = $item.find(".recommended-title").text().trim();
        const about = $item.find(".recommended-description").text().trim();
        const countText = $item.find(".members-count").text().trim();

        const members = countText
          ? parseInt(countText.replace(/[^0-9]/g, ""), 10)
          : null;

        const nameLower = name.toLowerCase();
        const aboutLower = about.toLowerCase();

        const groupMatches = groupWords.filter(
          (w) => nameLower.includes(w) || aboutLower.includes(w),
        ).length;
        const channelMatches = channelWords.filter(
          (w) => nameLower.includes(w) || aboutLower.includes(w),
        ).length;

        const probablyChannel =
          channelMatches >= 1 ||
          (members !== null &&
            members > 80000 &&
            !nameLower.includes("чат") &&
            !aboutLower.includes("чат"));

        if (groupMatches === 0 || channelMatches >= 1 || probablyChannel)
          continue;

        const path = $item.attr("href");
        if (!path || !path.startsWith("/linck/")) continue;

        const fullUrl = SITE + path;

        if (members !== null && members < 40) continue;

        collected.push({
          name,
          pageUrl: fullUrl,
          members,
          description: about,
        });

        foundOnPage++;
        await waitABit(900, 1700);
      }

      console.log(
        `Page ${currentPage} → ${foundOnPage} groups | total ${collected.length}`,
      );

      const hasMore =
        $(".pagination a[href*='page=" + (currentPage + 1) + "']").length > 0;

      if (!hasMore || collected.length >= limit || foundOnPage === 0) {
        shouldStop = true;
      }

      currentPage++;
    } catch (err) {
      console.error(`Page ${currentPage} failed: ${err.message}`);
      shouldStop = true;
    }
  }

  console.log(`Getting real links for ${collected.length} items...`);

  const goodOnes = [];
  for (const item of collected) {
    try {
      const realLink = await extractRealLink(item.pageUrl);
      if (realLink) {
        item.link = realLink;
        goodOnes.push(item);
      }
      await waitABit(700, 1400);
    } catch (err) {
      console.error(err);
    }
  }

  return goodOnes;
}

async function joinGroup(url) {
  if (!clientReady || !userClient) return "Клиент ещё не готов";

  try {
    if (url.includes("t.me/+") || url.includes("t.me/joinchat/")) {
      const hashPart = url.split(/\+|joinchat\//)[1]?.split(/[/?#]/)[0];
      if (!hashPart) throw new Error("bad hash");
      await userClient.invoke(
        new Api.messages.ImportChatInvite({ hash: hashPart }),
      );
    } else if (url.includes("t.me/")) {
      let username = url.split("t.me/")[1]?.split(/[/?#]/)[0];
      if (username.startsWith("@")) username = username.slice(1);
      if (!username) throw new Error("bad username");

      await userClient.invoke(
        new Api.channels.JoinChannel({
          channel: await userClient.getInputEntity(username),
        }),
      );
    } else {
      return "Не понимаю формат ссылки";
    }

    return "Вступил";
  } catch (err) {
    const text = err.message || String(err);
    if (text.includes("USER_ALREADY_PARTICIPANT")) return "Уже в группе";
    if (text.includes("INVITE_HASH_EXPIRED")) return "Ссылка устарела";
    if (text.includes("CHANNEL_PRIVATE")) return "Приватная группа";
    if (text.includes("FLOOD_WAIT"))
      return `FLOOD — жди ${err.seconds || "?"} сек`;
    if (text.includes("PEER_ID_INVALID")) return "Ссылка неверная";
    return `Ошибка: ${text.slice(0, 120)}`;
  }
}

bot.start((ctx) => {
  ctx.reply(
    "Команды:\n" +
      "/find [тема] [кол-во]     →  /find крипта 25\n" +
      "/addall                    → вступить во все найденные\n" +
      "/add <номер или ссылка>\n" +
      "/check                     → статус",
  );
});

bot.command("check", (ctx) => {
  ctx.reply(clientReady ? "Клиент готов" : "Клиент не авторизован");
});

bot.command("find", async (ctx) => {
  const parts = ctx.message.text.slice("/find".length).trim().split(/\s+/);
  let topic = parts[0] || "чат";
  let howMany = parseInt(parts[1]) || 6;
  if (howMany > 140) howMany = 140;

  const status = await ctx.reply(
    `Ищу по запросу «${topic}» (до ${howMany})...`,
  );

  try {
    const results = await findGroups(topic, howMany);

    if (results.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        `Ничего не нашёл по «${topic}». Попробуй другой запрос.`,
      );
      return;
    }

    const CHUNK = 14;
    const pieces = [];
    for (let i = 0; i < results.length; i += CHUNK) {
      pieces.push(results.slice(i, i + CHUNK));
    }

    for (let idx = 0; idx < pieces.length; idx++) {
      const piece = pieces[idx];
      let text =
        idx === 0
          ? `Нашёл ${results.length} групп\n\n`
          : `Продолжение (${idx + 1}/${pieces.length})\n\n`;

      piece.forEach((g, i) => {
        const num = idx * CHUNK + i + 1;
        text += `${num}. ${g.name}\n   ${g.link || g.pageUrl}\n   👥 ${g.members || "?"} чел.\n\n`;
      });

      if (idx === pieces.length - 1) {
        text += `\nДобавить всех → /addall\nИли по номеру → /add 3`;
      }

      if (idx === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          status.message_id,
          undefined,
          text,
        );
      } else {
        await ctx.reply(text);
      }

      if (idx < pieces.length - 1) await new Promise((r) => setTimeout(r, 900));
    }

    ctx.session.found = results;
  } catch (err) {
    console.error(err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `Что-то сломалось: ${err.message.slice(0, 180)}`,
    );
  }
});

bot.command("addall", async (ctx) => {
  if (!ctx.session.found?.length) {
    return ctx.reply("Сначала найди группы через /find");
  }

  const list = ctx.session.found;
  const progress = await ctx.reply(
    `Добавляюсь в ${list.length} групп (0/${list.length})`,
  );

  let log = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const res = await joinGroup(item.link);
    log.push(`${i + 1}. ${item.name} → ${res}`);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progress.message_id,
      undefined,
      `Добавление ${i + 1}/${list.length}\n\n${log.join("\n")}`,
    );

    await waitABit(2200, 3800);
  }

  await ctx.reply("Готово!\n\n" + log.join("\n"));
});

bot.command("add", async (ctx) => {
  const arg = ctx.message.text.slice("/add".length).trim();

  if (!arg) {
    return ctx.reply("Напиши номер из списка или ссылку t.me/...");
  }

  if (arg.includes("t.me") || arg.startsWith("http")) {
    const result = await joinGroup(arg);
    return ctx.reply(result);
  }

  const num = parseInt(arg) - 1;
  if (
    isNaN(num) ||
    num < 0 ||
    !ctx.session.found ||
    num >= ctx.session.found.length
  ) {
    return ctx.reply("Нет такого номера. Сначала /find");
  }

  const item = ctx.session.found[num];
  const result = await joinGroup(item.link);
  ctx.reply(`${item.name} → ${result}`);
});

bot.launch();
console.log("Бот работает");
