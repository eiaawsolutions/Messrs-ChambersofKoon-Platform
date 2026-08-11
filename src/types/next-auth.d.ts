import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      roleId: string;
      status: string;
      sessionEpoch: number;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    roleId?: string;
    status?: string;
    sessionEpoch?: number;
  }
}
