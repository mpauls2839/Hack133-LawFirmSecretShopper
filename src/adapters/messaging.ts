export interface SendSmsInput {
  to: string;
  from: string;
  body: string;
  /** Optional display name used when upserting a GHL contact. */
  contactName?: string;
}

export interface SendSmsResult {
  messageId: string;
  contactId?: string;
  conversationId?: string;
}

export interface MessagingAdapter {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  verifyWebhookSignature(
    signatureHeader: string | undefined,
    legacySignatureHeader: string | undefined,
    rawBody: string,
  ): boolean;
}

export class FakeMessagingAdapter implements MessagingAdapter {
  readonly sent: SendSmsInput[] = [];
  private counter = 0;
  validSignatures = true;

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    this.counter += 1;
    this.sent.push(input);
    return {
      messageId: `GHL_MSG_${this.counter}`,
      contactId: `GHL_CONTACT_${this.counter}`,
      conversationId: `GHL_CONV_${this.counter}`,
    };
  }

  verifyWebhookSignature(
    _signatureHeader: string | undefined,
    _legacySignatureHeader: string | undefined,
    _rawBody: string,
  ): boolean {
    return this.validSignatures;
  }
}
