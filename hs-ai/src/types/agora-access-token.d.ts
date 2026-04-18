declare module "agora-access-token" {
  export const RtcRole: {
    PUBLISHER: number;
    SUBSCRIBER: number;
  };

  export const RtcTokenBuilder: {
    buildTokenWithUid: (
      appId: string,
      appCertificate: string,
      channelName: string,
      uid: number,
      role: number,
      privilegeExpiredTs: number,
    ) => string;
  };
}
