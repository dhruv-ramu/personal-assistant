import { Hono } from "hono";
import { html } from "hono/html";
import logoPng from "../../brand/della-logo-120.png";
import { layout, type Html } from "../ui/layout";
import type { AppEnvBindings } from "./types";

/**
 * Public, static pages required to publish the Google OAuth app: a home page, a privacy policy,
 * and terms of service. They contain no owner data and need no session.
 */
const OPERATOR = "Dhruv";
const CONTACT = "dhruvramu@gmail.com";
const EFFECTIVE = "November 9, 2026";

const page = (title: string, body: Html) => layout({ title, active: "", csrf: null, simulatorEnabled: false, modes: [] }, body);

const footer = html`<p class="muted">
  <a href="/">Home</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a>
</p>`;

export function publicRoutes(): Hono<AppEnvBindings> {
  const app = new Hono<AppEnvBindings>();

  app.get("/logo.png", (c) => c.body(logoPng, 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }));

  app.get("/", (c) =>
    c.html(
      page(
        "Della",
        html`<div class="card">
            <img src="/logo.png" alt="Della logo" width="96" height="96" />
            <p>
              Della is a private, single-user personal assistant operated by ${OPERATOR} for his own use. It sends him reminders by text message, places wake-up calls to his own
              phone, reads and (only when he asks) updates his own Google Calendar, and remembers notes he chooses to save.
            </p>
            <p>Della has one user. It does not offer accounts to the public, and it never messages or calls anyone other than its owner.</p>
            <p><a href="/admin">Owner sign-in</a></p>
          </div>
          ${footer}`,
      ),
    ),
  );

  app.get("/privacy", (c) =>
    c.html(
      page(
        "Privacy Policy",
        html`<div class="card">
            <p class="muted">Effective ${EFFECTIVE}</p>
            <h2>Who we are</h2>
            <p>
              Della ("the app") is a personal assistant operated by ${OPERATOR} ("the operator") for his own personal use. It has a single user, the operator. Questions about this
              policy: <a href="mailto:${CONTACT}">${CONTACT}</a>.
            </p>

            <h2>Information the app processes</h2>
            <ul>
              <li>
                <strong>Messages and calls:</strong> text messages the owner sends to the app, the app's replies, and call status (for example, whether a wake-up call was answered
                and which key was pressed).
              </li>
              <li><strong>Tasks, reminders, and notes</strong> the owner creates, including things the owner asks the app to remember.</li>
              <li>
                <strong>Google Calendar data</strong> (only after the owner connects it): the list of the owner's calendars and the events on the calendars the owner selects. The
                app creates, moves, or cancels events only when the owner explicitly asks.
              </li>
              <li>
                <strong>Gmail metadata</strong> (only if the owner connects it, read-only): sender, subject, a short snippet, and date of recent messages, used to check whether
                someone the owner is waiting on has replied. The app cannot send, delete, or modify email.
              </li>
              <li>
                <strong>Photos</strong> the owner chooses to upload for an accountability check. Location and camera metadata are removed before storage, and photos are deleted
                within 24 hours.
              </li>
              <li><strong>Browser companion</strong> (optional): a check-in click and a coarse active/idle state. It never reads tabs, web pages, URLs, or browsing history.</li>
              <li><strong>Operational data:</strong> timestamps, delivery status, usage counts, and security logs with phone numbers and secrets redacted.</li>
            </ul>

            <h2>How information is used</h2>
            <p>
              Only to provide the app's features to its owner: interpreting requests, sending reminders, placing requested calls, answering questions from the owner's own records,
              and keeping the service secure and within its usage limits. The app does not sell data, show advertising, build advertising profiles, or use data to train
              machine-learning models.
            </p>

            <h2>Google user data</h2>
            <p>
              The app's use and transfer of information received from Google APIs adheres to the
              <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google
              data is used only to provide the calendar and email features the owner requested, is not transferred to others except as necessary to provide those features (see
              service providers below), is not used for advertising, and is not read by humans except with the owner's consent, for security purposes, or where required by law.
            </p>

            <h2>Service providers</h2>
            <p>The app runs on, and sends data only as needed to:</p>
            <ul>
              <li>Cloudflare (hosting, database, storage)</li>
              <li>Twilio (text messages and phone calls to the owner)</li>
              <li>Google (Calendar, and Gmail if connected)</li>
              <li>OpenAI (to interpret free-form messages and, if enabled, to describe check-in photos; requests are sent with storage disabled where the API allows)</li>
              <li>The US National Weather Service (weather for a location the owner sets, if enabled)</li>
            </ul>
            <p>These providers process data under their own terms and privacy policies.</p>

            <h2>Storage, security, and retention</h2>
            <p>
              Sensitive text is encrypted by the app before it is stored, and access to the dashboard requires the owner's secret. The app (and any provider it sends a request to)
              can read data while processing it; this is not end-to-end encryption. Message content is kept for 30 days by default, completed tasks for 90 days, uploaded photos for
              24 hours, and saved memories until the owner deletes them. Google tokens are stored encrypted and deleted when the owner disconnects.
            </p>

            <h2>Your choices and deletion</h2>
            <p>
              The owner can export or erase all app data from the dashboard, delete individual memories by text ("forget that"), disconnect Google at any time from the dashboard or
              at
              <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, and stop all text messages by replying STOP. Copies held by service providers
              and existing backups are governed by those providers' policies.
            </p>

            <h2>Children</h2>
            <p>The app is not directed to children under 13 and has a single adult user.</p>

            <h2>Changes</h2>
            <p>Updates will be posted on this page with a new effective date.</p>
          </div>
          ${footer}`,
      ),
    ),
  );

  app.get("/terms", (c) =>
    c.html(
      page(
        "Terms of Service",
        html`<div class="card">
            <p class="muted">Effective ${EFFECTIVE}</p>
            <h2>1. The service</h2>
            <p>
              Della is a private personal assistant operated by ${OPERATOR} for his own use. Access is limited to its owner. No one else may sign in or use the service, and there
              are no public accounts.
            </p>
            <h2>2. Acceptable use</h2>
            <p>
              The service may only be used to manage the owner's own reminders, calendar, calls, and notes. It may not be used to message or call anyone other than the owner, to
              send marketing, or to break any law or provider policy.
            </p>
            <h2>3. Third-party services</h2>
            <p>The service depends on Cloudflare, Twilio, Google, and OpenAI. Their availability, terms, and charges are outside the operator's control.</p>
            <h2>4. No warranty</h2>
            <p>
              The service is provided "as is" without warranties of any kind. Reminders, wake-up calls, and calendar updates are best effort and may be delayed or fail. Keep your
              phone's own alarm for anything important. Accountability check-ins record only what was answered; they are not proof of work or wakefulness.
            </p>
            <h2>5. Limitation of liability</h2>
            <p>To the extent permitted by law, the operator is not liable for missed reminders, calls, calendar changes, lost data, or any indirect or consequential damages.</p>
            <h2>6. Ending use</h2>
            <p>
              The owner can stop messages at any time by replying STOP, disconnect integrations, or erase all data from the dashboard. The operator may discontinue the service at
              any time.
            </p>
            <h2>7. Changes</h2>
            <p>These terms may be updated; changes are posted on this page with a new effective date.</p>
            <h2>8. Contact</h2>
            <p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
          </div>
          ${footer}`,
      ),
    ),
  );

  return app;
}
