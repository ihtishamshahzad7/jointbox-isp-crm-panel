import { Test, TestingModule } from '@nestjs/testing';
import { NasService } from './nas.service';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from './mikrotik-sync.service';
import { RadiusSyncService } from './radius-sync.service';

describe('NasService', () => {
  let service: NasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NasService,
        { provide: PrismaService,       useValue: {} },
        { provide: MikrotikSyncService, useValue: {} },
        { provide: RadiusSyncService,   useValue: {} },
      ],
    }).compile();

    service = module.get<NasService>(NasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});