
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.18'
  }
  "public": {
          Tables: {
            "accounts": {
                  Row: {
                    "account_key_by_pass": NonNullable<Json>,"account_key_by_recovery": NonNullable<Json>,"account_key_version": number,"created_at": string,"kdf": NonNullable<Json>,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_key_by_pass": NonNullable<Json>,"account_key_by_recovery": NonNullable<Json>,"account_key_version"?: number,"created_at"?: string,"kdf": NonNullable<Json>,"user_id": string
                  }
                  Update: {
                    "account_key_by_pass"?: NonNullable<Json>,"account_key_by_recovery"?: NonNullable<Json>,"account_key_version"?: number,"created_at"?: string,"kdf"?: NonNullable<Json>,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"chunks": {
                  Row: {
                    "created_at": string,"device_id": string,"kind": string,"object_name": string,"seq": number,"session_id": string,"size": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_id": string,"kind": string,"object_name": string,"seq": number,"session_id": string,"size": number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"device_id"?: string,"kind"?: string,"object_name"?: string,"seq"?: number,"session_id"?: string,"size"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "chunks_device_id_fkey"
      columns: ["device_id"]
isOneToOne: false
      referencedRelation: "devices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chunks_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "sessions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chunks_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["user_id"]
    }
                  ]
                },"devices": {
                  Row: {
                    "auth_session_id": string,"created_at": string,"id": string,"last_seen_at": string | null,"name_enc": NonNullable<Json>,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_session_id": string,"created_at"?: string,"id"?: string,"last_seen_at"?: string | null,"name_enc": NonNullable<Json>,"status"?: string,"user_id": string
                  }
                  Update: {
                    "auth_session_id"?: string,"created_at"?: string,"id"?: string,"last_seen_at"?: string | null,"name_enc"?: NonNullable<Json>,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "devices_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["user_id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "id": string,"meta_enc": NonNullable<Json>,"project_tag": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"meta_enc": NonNullable<Json>,"project_tag": string,"user_id": string
                  }
                  Update: {
                    "id"?: string,"meta_enc"?: NonNullable<Json>,"project_tag"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["user_id"]
    }
                  ]
                },"sessions": {
                  Row: {
                    "account_key_version": number,"deleted_at": string | null,"harness": string,"head_seq": number,"id": string,"meta_enc": NonNullable<Json>,"project_id": string | null,"session_key": NonNullable<Json>,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_key_version": number,"deleted_at"?: string | null,"harness": string,"head_seq"?: number,"id": string,"meta_enc": NonNullable<Json>,"project_id"?: string | null,"session_key": NonNullable<Json>,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_key_version"?: number,"deleted_at"?: string | null,"harness"?: string,"head_seq"?: number,"id"?: string,"meta_enc"?: NonNullable<Json>,"project_id"?: string | null,"session_key"?: NonNullable<Json>,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sessions_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sessions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["user_id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "commit_chunk":
{ Args: { "p_kind": string,"p_object_name": string,"p_seq": number,"p_session_id": string,"p_size": number }; Returns: undefined
                           },
"storage_used":
{ Args: { "p_user_id": string }; Returns: number
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
