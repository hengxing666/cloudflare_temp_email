import { Context } from "hono";
import { HonoCustomType } from "../types";
import { CONSTANTS } from "../constants";
import { AdminWebhookSettings, WebhookMail } from "../models/models";
import { getBooleanValue } from "../utils";
import PostalMime from 'postal-mime';


class WebhookSettings {
    url: string = ''
    method: string = 'POST'
    headers: string = JSON.stringify({
        "Content-Type": "application/json"
    }, null, 2)
    body: string = JSON.stringify({
        "from": "${from}",
        "to": "${to}",
        "headers": "${headers}",
        "subject": "${subject}",
        "raw": "${raw}",
        "parsedText": "${parsedText}",
    }, null, 2)
}


async function getWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    if (!c.env.KV) {
        return c.text("KV is not available", 400);
    }
    if (!getBooleanValue(c.env.ENABLE_WEBHOOK)) {
        return c.text("Webhook is disabled", 403);
    }
    const { address } = c.get("jwtPayload")
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (!adminSettings?.allowList.includes(address)) {
        return c.text("Webhook settings is not allowed for this user", 403);
    }
    const settings = await c.env.KV.get<WebhookSettings>(
        `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`, "json"
    ) || new WebhookSettings();
    return c.json(settings);
}


async function saveWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const { address } = c.get("jwtPayload")
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (!adminSettings?.allowList.includes(address)) {
        return c.text("Webhook settings is not allowed for this user", 403);
    }
    const settings = await c.req.json<WebhookSettings>();
    await c.env.KV.put(
        `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`,
        JSON.stringify(settings));
    return c.json({ success: true })
}

async function sendWebhook(settings: WebhookSettings, formatMap: WebhookMail): Promise<{ success: boolean, message?: string }> {
    // send webhook
    let body = settings.body;
    for (const key of Object.keys(formatMap)) {
        body = body.replace(
            new RegExp(`\\$\\{${key}\\}`, "g"),
            JSON.stringify(
                formatMap[key as keyof WebhookMail]
            ).replace(/^"(.*)"$/, '\$1')
        );
    }
    const response = await fetch(settings.url, {
        method: settings.method,
        headers: JSON.parse(settings.headers),
        body: body
    });
    if (!response.ok) {
        console.log("send webhook error", response.status, response.statusText);
        return { success: false, message: `send webhook error: ${response.status} ${response.statusText}` };
    }
    return { success: true }
}

export async function trigerWebhook(
    c: Context<HonoCustomType>,
    address: string,
    raw_mail: string
): Promise<void> {
    if (!c.env.KV || !getBooleanValue(c.env.ENABLE_WEBHOOK)) {
        return
    }
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (!adminSettings?.allowList.includes(address)) {
        return;
    }
    const settings = await c.env.KV.get<WebhookSettings>(
        `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`, "json"
    );
    if (!settings) {
        return;
    }
    const parsedEmail = await PostalMime.parse(raw_mail);
    const res = await sendWebhook(settings, {
        from: parsedEmail.from.address || "",
        to: address,
        headers: JSON.stringify(parsedEmail.headers),
        subject: parsedEmail.subject || "",
        raw: raw_mail,
        parsedText: parsedEmail.text || parsedEmail.html || ""
    });
    if (!res.success) {
        console.log(res.message);
    }
}

async function testWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await c.req.json<WebhookSettings>();
    const { address } = c.get("jwtPayload");
    // random raw email
    const raw = await c.env.DB.prepare(
        `SELECT raw FROM raw_mails WHERE address = ? ORDER BY RANDOM() LIMIT 1`
    ).bind(address).first<string>("raw");
    const parsedEmail = raw ? await PostalMime.parse(raw) : {} as any;
    const res = await sendWebhook(settings, {
        from: parsedEmail?.from?.address || "test@test.com",
        to: address,
        headers: JSON.stringify(parsedEmail?.headers || { "X-Test": "test" }),
        subject: parsedEmail?.subject || "test subject",
        raw: raw || "test raw email",
        parsedText: parsedEmail?.text || parsedEmail?.html || "test parsed text"
    });
    if (!res.success) {
        return c.text(res.message || "send webhook error", 400);
    }
    return c.json({ success: true });
}

export default {
    getWebhookSettings,
    saveWebhookSettings,
    testWebhookSettings,
}
