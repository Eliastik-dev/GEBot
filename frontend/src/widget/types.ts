export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  messageId?: string | null | undefined;
  feedback?: number | null | undefined;
};

export type Audience = "professional" | "particulier" | null;

export type ProductTheme =
  | "plomberie"
  | "piscine"
  | "chauffage"
  | "batiment"
  | "maintenance"
  | "automobile"
  | "eco-conception"
  | null;

export type Locale = "fr" | "en" | "nl" | "pl";

export type GeolocationConsent = "pending" | "accepted" | "declined";

export type FooterEditMode = "profile" | "domain" | null;

export type ChatStreamPayload = {
  delta?: string;
  replaceContent?: string;
  done?: boolean;
  error?: string;
  sessionId?: string;
  sessionToken?: string;
  audience?: Audience;
  theme?: Exclude<ProductTheme, null>;
  showThemeReplies?: boolean;
  status?: "searching" | "generating";
  handoff?: { label: string; phone: string } | null;
  geoCountry?: string | null;
  messageId?: string | null;
};

export type Handoff = { label: string; phone: string };
