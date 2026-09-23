import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {
  validateToken(token: string): Promise<boolean> {
    return Promise.resolve(Boolean(token));
  }
}
