import { Module } from '@nestjs/common';
import { ToneController } from './tone.controller';
import { ToneService } from './tone.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  controllers: [ToneController],
  providers: [ToneService],
  exports: [ToneService],
})
export class ToneModule {}