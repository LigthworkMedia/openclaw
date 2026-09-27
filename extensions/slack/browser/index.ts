import { createSessionHeaderLink, defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";

export default defineControlUiPlugin({
  id: "slack",
  activate(host) {
    return host.ui.registerAccessory({
      id: "conversation-origin",
      placement: "session-header",
      mount: createSessionHeaderLink(({ conversationLink }) => {
        const hostname = conversationLink && URL.parse(conversationLink.url)?.hostname;
        return hostname &&
          (hostname === "slack.com" ||
            hostname.endsWith(".slack.com") ||
            hostname === "slack-gov.com" ||
            hostname.endsWith(".slack-gov.com"))
          ? conversationLink
          : undefined;
      }),
    });
  },
});
