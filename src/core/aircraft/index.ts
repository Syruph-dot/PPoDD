import { AircraftType } from '../../entities/types';
import { AircraftProfile } from './types';
import { scatterAircraftProfile } from './scatterAircraft';
import { laserAircraftProfile } from './laserAircraft';
import { trackingAircraftProfile } from './trackingAircraft';

const AIRCRAFT_PROFILES: Record<AircraftType, AircraftProfile> = {
  scatter: scatterAircraftProfile,
  laser: laserAircraftProfile,
  tracking: trackingAircraftProfile,
};

export const getAircraftProfile = (type: AircraftType): AircraftProfile => AIRCRAFT_PROFILES[type];
