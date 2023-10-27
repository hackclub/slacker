const slackItem = ({ length }) => ({
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Found *${length} action items* that need attention`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*<fakeLink.toHotelPage.com|how to fix this api?>*",
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: "*Channel:*\n<#C02UN35M7LG>",
        },
        {
          type: "mrkdwn",
          text: "*Author:*\n<@U014ND5P1N2>",
        },
        {
          type: "mrkdwn",
          text: "*Submitted on:*\nAug 10",
        },
        {
          type: "mrkdwn",
          text: "*Last reply on:*\n5m ago",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "image",
          image_url:
            "https://api.slack.com/img/blocks/bkb_template_images/tripAgentLocationMarker.png",
          alt_text: "Location Pin Icon",
        },
        {
          type: "mrkdwn",
          text: "Total replies: 3",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            emoji: true,
            text: "Resolve",
          },
          style: "primary",
          value: "click_me_123",
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            emoji: true,
            text: "Next 2 Results",
          },
          value: "click_me_123",
        },
      ],
    },
  ],
});
