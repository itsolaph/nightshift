// Hand-written types for the PayPal REST fields Nightshift reads and sends, in PayPal's own
// snake_case. Only what the app uses; PayPal returns more.

export type Amount = { currency_code: string; value: string };
export type Link = { href: string; rel: string; method?: string };

export type OAuthToken = { access_token: string; token_type: string; expires_in: number; app_id?: string; scope?: string };

export type PayPalError = {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { field?: string; value?: string; location?: string; issue?: string; description?: string }[];
  links?: Link[];
};

// --- Orders -----------------------------------------------------------------------

export type CardSource = {
  number: string;
  expiry: string; // YYYY-MM
  security_code?: string;
  name?: string;
  billing_address?: {
    address_line_1?: string;
    admin_area_2?: string;
    admin_area_1?: string;
    postal_code?: string;
    country_code: string;
  };
};

export type PurchaseUnitRequest = {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  description?: string;
  soft_descriptor?: string;
  amount: Amount & { breakdown?: { item_total?: Amount; shipping?: Amount } };
  items?: { name: string; quantity: string; unit_amount: Amount; sku?: string }[];
};

export type CreateOrderRequest = {
  intent: "AUTHORIZE" | "CAPTURE";
  purchase_units: PurchaseUnitRequest[];
  payment_source?: { card?: CardSource };
};

export type Authorization = {
  id: string;
  status: "CREATED" | "CAPTURED" | "DENIED" | "PARTIALLY_CAPTURED" | "VOIDED" | "PENDING" | "EXPIRED" | string;
  status_details?: { reason?: string };
  amount: Amount;
  invoice_id?: string;
  custom_id?: string;
  expiration_time?: string;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  links?: Link[];
};

export type Capture = {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED" | string;
  status_details?: { reason?: string };
  amount: Amount;
  final_capture?: boolean;
  invoice_id?: string;
  custom_id?: string;
  seller_receivable_breakdown?: { gross_amount: Amount; paypal_fee?: Amount; net_amount?: Amount };
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string } };
  links?: Link[];
};

export type Refund = {
  id: string;
  status: "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED" | string;
  status_details?: { reason?: string };
  amount: Amount;
  note_to_payer?: string;
  create_time?: string;
  update_time?: string;
  links?: Link[];
};

export type Order = {
  id: string;
  intent: "AUTHORIZE" | "CAPTURE";
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED" | string;
  create_time?: string;
  update_time?: string;
  payment_source?: {
    card?: { name?: string; last_digits?: string; brand?: string; expiry?: string };
    paypal?: { email_address?: string; account_id?: string };
  };
  payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    description?: string;
    amount?: Amount;
    payments?: { authorizations?: Authorization[]; captures?: Capture[]; refunds?: Refund[] };
  }[];
  links?: Link[];
};

export type CaptureAuthorizationRequest = {
  amount?: Amount;
  final_capture?: boolean;
  invoice_id?: string;
  note_to_payer?: string;
  soft_descriptor?: string;
};

export type RefundRequest = { amount?: Amount; invoice_id?: string; note_to_payer?: string };

// --- Invoicing --------------------------------------------------------------------

export type InvoiceItem = { name: string; quantity: string; unit_amount: Amount; unit_of_measure?: "QUANTITY" | "HOURS" | "AMOUNT" };

export type CreateInvoiceRequest = {
  detail: {
    currency_code: string;
    invoice_number?: string;
    invoice_date?: string; // YYYY-MM-DD
    note?: string;
    payment_term?: { term_type?: string; due_date?: string };
  };
  invoicer?: { name?: { given_name?: string; surname?: string }; business_name?: string };
  primary_recipients?: { billing_info: { email_address: string; name?: { given_name?: string; surname?: string } } }[];
  items: InvoiceItem[];
  configuration?: { allow_tip?: boolean; partial_payment?: { allow_partial_payment: boolean; minimum_amount_due?: Amount } };
};

export type Invoice = {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    invoice_date?: string;
    currency_code: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string; last_update_time?: string; last_sent_time?: string };
  };
  primary_recipients?: { billing_info?: { email_address?: string; name?: { full_name?: string; given_name?: string; surname?: string } } }[];
  amount?: Amount & { breakdown?: unknown };
  due_amount?: Amount;
  payments?: { paid_amount?: Amount; transactions?: { payment_id?: string; amount?: Amount; method?: string; payment_date?: string }[] };
  refunds?: { refund_amount?: Amount };
  links?: Link[];
};

export type InvoiceList = { items?: Invoice[]; total_items?: number; total_pages?: number; links?: Link[] };

export type InvoiceNotification = {
  subject?: string;
  note?: string;
  send_to_invoicer?: boolean;
  send_to_recipient?: boolean;
  additional_recipients?: string[];
};

export type RecordPaymentRequest = {
  method: "BANK_TRANSFER" | "CASH" | "CHECK" | "CREDIT_CARD" | "DEBIT_CARD" | "PAYPAL" | "WIRE_TRANSFER" | "OTHER";
  payment_date?: string;
  amount: Amount;
  note?: string;
};

// --- Transaction Search -----------------------------------------------------------

export type TransactionDetail = {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    paypal_reference_id_type?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: Amount;
    fee_amount?: Amount;
    transaction_status?: string;
    invoice_id?: string;
    custom_field?: string;
  };
  payer_info?: { email_address?: string; account_id?: string };
  cart_info?: unknown;
};

export type TransactionSearch = {
  transaction_details?: TransactionDetail[];
  account_number?: string;
  start_date?: string;
  end_date?: string;
  last_refreshed_datetime?: string;
  page?: number;
  total_items?: number;
  total_pages?: number;
};

export type Balances = {
  balances?: { currency: string; primary?: boolean; total_balance: Amount; available_balance?: Amount; withheld_balance?: Amount }[];
  account_id?: string;
  as_of_time?: string;
  last_refresh_time?: string;
};

// --- Disputes ----------------------------------------------------------------------

export type DisputeSummary = {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  status: string;
  reason?: string;
  dispute_state?: string;
  dispute_amount?: Amount;
  seller_response_due_date?: string;
  disputed_transactions?: { seller_transaction_id?: string; buyer_transaction_id?: string }[];
};
export type DisputeList = { items?: DisputeSummary[]; links?: Link[] };

// --- Webhooks ----------------------------------------------------------------------

export type Webhook = { id: string; url: string; event_types: { name: string; description?: string }[] };

export type WebhookEvent = {
  id: string;
  create_time?: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  resource: Record<string, unknown>;
};

export type VerifyWebhookSignatureRequest = {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: unknown;
};
