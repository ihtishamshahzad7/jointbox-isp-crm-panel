import { Controller, Get, Post, Put, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotesService } from './notes.service';

@UseGuards(JwtAuthGuard)
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  /** GET /notes?entityType=SUBSCRIBER&entityId=12 */
  @Get()
  list(@Query('entityType') entityType: string, @Query('entityId') entityId: string, @Req() req: any) {
    return this.notes.list(req.user, entityType, Number(entityId));
  }

  @Post()
  add(@Body() body: { entityType: string; entityId: number; body: string; pinned?: boolean }, @Req() req: any) {
    return this.notes.add(req.user, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: { body?: string; pinned?: boolean }, @Req() req: any) {
    return this.notes.update(req.user, +id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.notes.remove(req.user, +id);
  }
}
