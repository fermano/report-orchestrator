import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const correlationId =
      request.headers['x-correlation-id'] || request.headers['x-request-id'] || uuidv4();
    request.correlationId = correlationId;
    request.headers['x-correlation-id'] = correlationId;

    return next.handle();
  }
}
